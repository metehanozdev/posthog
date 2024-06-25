import { randomUUID } from 'crypto'
import { Redis } from 'ioredis'
import { Message, TopicPartition, TopicPartitionOffset } from 'node-rdkafka'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'path'

import { waitForExpect } from '../../../../functional_tests/expectations'
import { defaultConfig } from '../../../../src/config/config'
import { SessionRecordingIngester } from '../../../../src/main/ingestion-queues/session-recording/session-recordings-consumer'
import { Hub, PluginsServerConfig, Team } from '../../../../src/types'
import { createHub } from '../../../../src/utils/db/hub'
import { deleteKeysWithPrefix } from '../../../helpers/redis'
import { getFirstTeam, resetTestDatabase } from '../../../helpers/sql'
import { createIncomingRecordingMessage, createKafkaMessage, createTP } from './fixtures'

const SESSION_RECORDING_REDIS_PREFIX = '@posthog-tests/replay/'
const CAPTURE_OVERFLOW_REDIS_KEY = '@posthog/capture-overflow/replay'

const config: PluginsServerConfig = {
    ...defaultConfig,
    SESSION_RECORDING_PARTITION_REVOKE_OPTIMIZATION: true,
    SESSION_RECORDING_OVERFLOW_ENABLED: true,
    SESSION_RECORDING_OVERFLOW_BUCKET_CAPACITY: 1_000_000, // 1MB burst
    SESSION_RECORDING_OVERFLOW_BUCKET_REPLENISH_RATE: 1_000, // 1kB/s replenish
    SESSION_RECORDING_OVERFLOW_MIN_PER_BATCH: 1,
    SESSION_RECORDING_REDIS_PREFIX,
}

const noop = () => undefined

async function deleteKeys(hub: Hub) {
    await deleteKeysWithPrefix(hub.redisPool, SESSION_RECORDING_REDIS_PREFIX)
}

const mockConsumer = {
    on: jest.fn(),
    commitSync: jest.fn(),
    commit: jest.fn(),
    queryWatermarkOffsets: jest.fn(),
    committed: jest.fn(),
    assignments: jest.fn(),
    isConnected: jest.fn(() => true),
    getMetadata: jest.fn(),
}

jest.mock('../../../../src/kafka/batch-consumer', () => {
    return {
        startBatchConsumer: jest.fn(() =>
            Promise.resolve({
                join: () => ({
                    finally: jest.fn(),
                }),
                stop: jest.fn(),
                consumer: mockConsumer,
            })
        ),
    }
})

jest.setTimeout(1000)

describe.each([[true], [false]])('ingester with consumeOverflow=%p', (consumeOverflow) => {
    let ingester: SessionRecordingIngester

    let hub: Hub
    let closeHub: () => Promise<void>
    let team: Team
    let teamToken = ''
    let mockOffsets: Record<number, number> = {}
    let mockCommittedOffsets: Record<number, number> = {}
    let redisConn: Redis
    const consumedTopic = consumeOverflow
        ? 'session_recording_snapshot_item_overflow_test'
        : 'session_recording_snapshot_item_events_test'

    beforeAll(async () => {
        mkdirSync(path.join(config.SESSION_RECORDING_LOCAL_DIRECTORY, 'session-buffer-files'), { recursive: true })
        await resetTestDatabase()
    })

    beforeEach(async () => {
        // The below mocks simulate committing to kafka and querying the offsets
        mockCommittedOffsets = {}
        mockOffsets = {}
        mockConsumer.commit.mockImplementation(
            (tpo: TopicPartitionOffset) => (mockCommittedOffsets[tpo.partition] = tpo.offset)
        )
        mockConsumer.queryWatermarkOffsets.mockImplementation((_topic, partition, _timeout, cb) => {
            cb(null, { highOffset: mockOffsets[partition] ?? 1, lowOffset: 0 })
        })

        mockConsumer.getMetadata.mockImplementation((options, cb) => {
            cb(null, {
                topics: [{ name: options.topic, partitions: [{ id: 0 }, { id: 1 }, { id: 2 }] }],
            })
        })

        mockConsumer.committed.mockImplementation((topicPartitions: TopicPartition[], _timeout, cb) => {
            const tpos: TopicPartitionOffset[] = topicPartitions.map((tp) => ({
                topic: tp.topic,
                partition: tp.partition,
                offset: mockCommittedOffsets[tp.partition] ?? 1,
            }))

            cb(null, tpos)
        })
        ;[hub, closeHub] = await createHub()
        team = await getFirstTeam(hub)
        teamToken = team.api_token
        redisConn = await hub.redisPool.acquire(0)
        await redisConn.del(CAPTURE_OVERFLOW_REDIS_KEY)
        await deleteKeys(hub)

        ingester = new SessionRecordingIngester(config, hub.postgres, hub.objectStorage, consumeOverflow, redisConn)
        await ingester.start()

        mockConsumer.assignments.mockImplementation(() => [createTP(0, consumedTopic), createTP(1, consumedTopic)])
    })

    afterEach(async () => {
        jest.setTimeout(10000)
        await redisConn.del(CAPTURE_OVERFLOW_REDIS_KEY)
        await hub.redisPool.release(redisConn)
        await deleteKeys(hub)
        await closeHub()
    })

    afterAll(() => {
        rmSync(config.SESSION_RECORDING_LOCAL_DIRECTORY, { recursive: true, force: true })
        jest.useRealTimers()
    })
    const commitAllOffsets = async () => {
        // Simulate a background refresh for testing
        await ingester.commitAllOffsets(ingester.partitionMetrics, Object.values(ingester.sessions))
    }

    const createMessage = (session_id: string, partition = 1, messageOverrides: Partial<Message> = {}) => {
        mockOffsets[partition] = mockOffsets[partition] ?? 0
        mockOffsets[partition]++

        return createKafkaMessage(
            consumedTopic,
            teamToken,
            {
                partition,
                offset: mockOffsets[partition],
                ...messageOverrides,
            },
            {
                $session_id: session_id,
            }
        )
    }

    // disconnecting a producer is not safe to call multiple times
    // in order to let us test stopping the ingester elsewhere
    // in most tests we automatically stop the ingester during teardown
    describe('when ingester.stop is called in teardown', () => {
        afterEach(async () => {
            await ingester.stop()
        })
        it('can parse debug partition config', () => {
            const config = {
                SESSION_RECORDING_DEBUG_PARTITION: '103',
                KAFKA_HOSTS: 'localhost:9092',
            } satisfies Partial<PluginsServerConfig> as PluginsServerConfig

            const ingester = new SessionRecordingIngester(
                config,
                hub.postgres,
                hub.objectStorage,
                consumeOverflow,
                undefined
            )
            expect(ingester['debugPartition']).toEqual(103)
        })

        it('can parse absence of debug partition config', () => {
            const config = {
                KAFKA_HOSTS: 'localhost:9092',
            } satisfies Partial<PluginsServerConfig> as PluginsServerConfig

            const ingester = new SessionRecordingIngester(
                config,
                hub.postgres,
                hub.objectStorage,
                consumeOverflow,
                undefined
            )
            expect(ingester['debugPartition']).toBeUndefined()
        })

        it('creates a new session manager if needed', async () => {
            const event = createIncomingRecordingMessage()
            await ingester.consume(event)
            await waitForExpect(() => {
                expect(Object.keys(ingester.sessions).length).toBe(1)
                expect(ingester.sessions['1-session_id_1']).toBeDefined()
            })
        })

        it('removes sessions on destroy', async () => {
            await ingester.consume(createIncomingRecordingMessage({ team_id: 2, session_id: 'session_id_1' }))
            await ingester.consume(createIncomingRecordingMessage({ team_id: 2, session_id: 'session_id_2' }))

            expect(Object.keys(ingester.sessions).length).toBe(2)
            expect(ingester.sessions['2-session_id_1']).toBeDefined()
            expect(ingester.sessions['2-session_id_2']).toBeDefined()

            await ingester.destroySessions([['2-session_id_1', ingester.sessions['2-session_id_1']]])

            expect(Object.keys(ingester.sessions).length).toBe(1)
            expect(ingester.sessions['2-session_id_2']).toBeDefined()
        })

        it('handles multiple incoming sessions', async () => {
            const event = createIncomingRecordingMessage()
            const event2 = createIncomingRecordingMessage({
                session_id: 'session_id_2',
            })
            await Promise.all([ingester.consume(event), ingester.consume(event2)])
            expect(Object.keys(ingester.sessions).length).toBe(2)
            expect(ingester.sessions['1-session_id_1']).toBeDefined()
            expect(ingester.sessions['1-session_id_2']).toBeDefined()
        })

        // This test is flaky and no-one has time to look into it https://posthog.slack.com/archives/C0460HY55M0/p1696437876690329
        it.skip('destroys a session manager if finished', async () => {
            const sessionId = `destroys-a-session-manager-if-finished-${randomUUID()}`
            const event = createIncomingRecordingMessage({
                session_id: sessionId,
            })
            await ingester.consume(event)
            expect(ingester.sessions[`1-${sessionId}`]).toBeDefined()
            // Force the flush
            ingester.partitionMetrics[event.metadata.partition] = {
                lastMessageTimestamp: Date.now() + defaultConfig.SESSION_RECORDING_MAX_BUFFER_AGE_SECONDS,
            }

            await ingester.flushAllReadySessions(noop)

            await waitForExpect(() => {
                expect(ingester.sessions[`1-${sessionId}`]).not.toBeDefined()
            }, 10000)
        })

        describe('offset committing', () => {
            it('should commit offsets in simple cases', async () => {
                await ingester.handleEachBatch([createMessage('sid1'), createMessage('sid1')], noop)
                expect(ingester.partitionMetrics[1]).toMatchObject({
                    lastMessageOffset: 2,
                })

                await commitAllOffsets()
                // Doesn't flush if we have a blocking session
                expect(mockConsumer.commit).toHaveBeenCalledTimes(0)
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await commitAllOffsets()

                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        offset: 2 + 1,
                        partition: 1,
                    })
                )
            })

            it.skip('should commit higher values but not lower', async () => {
                await ingester.handleEachBatch([createMessage('sid1')], noop)
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                expect(ingester.partitionMetrics[1].lastMessageOffset).toBe(1)
                await commitAllOffsets()

                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        partition: 1,
                        offset: 2,
                    })
                )

                // Repeat commit doesn't do anything
                await commitAllOffsets()
                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)

                await ingester.handleEachBatch([createMessage('sid1')], noop)
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await commitAllOffsets()

                expect(mockConsumer.commit).toHaveBeenCalledTimes(2)
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        partition: 1,
                        offset: 2 + 1,
                    })
                )
            })

            it('should commit the lowest known offset if there is a blocking session', async () => {
                await ingester.handleEachBatch(
                    [createMessage('sid1'), createMessage('sid2'), createMessage('sid2'), createMessage('sid2')],
                    noop
                )
                await ingester.sessions[`${team.id}-sid2`].flush('buffer_age')
                await commitAllOffsets()

                expect(ingester.partitionMetrics[1]).toMatchObject({
                    lastMessageOffset: 4,
                })

                // No offsets are below the blocking one
                expect(mockConsumer.commit).not.toHaveBeenCalled()
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')

                // Subsequent commit will commit the last known offset
                await commitAllOffsets()
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        partition: 1,
                        offset: 4 + 1,
                    })
                )
            })

            it('should commit one lower than the blocking session if that is the highest', async () => {
                await ingester.handleEachBatch(
                    [createMessage('sid1'), createMessage('sid2'), createMessage('sid2'), createMessage('sid2')],
                    noop
                )
                // Flush the second session so the first one is still blocking
                await ingester.sessions[`${team.id}-sid2`].flush('buffer_age')
                await commitAllOffsets()

                // No offsets are below the blocking one
                expect(mockConsumer.commit).not.toHaveBeenCalled()

                // Add a new message and session and flush the old one
                await ingester.handleEachBatch([createMessage('sid2')], noop)
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await commitAllOffsets()

                // We should commit the offset of the blocking session
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        partition: 1,
                        offset: ingester.sessions[`${team.id}-sid2`].getLowestOffset(),
                    })
                )
            })

            it.skip('should not be affected by other partitions ', async () => {
                await ingester.handleEachBatch(
                    [createMessage('sid1', 1), createMessage('sid2', 2), createMessage('sid2', 2)],
                    noop
                )

                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await ingester.handleEachBatch([createMessage('sid1', 1)], noop)

                // We should now have a blocking session on partition 1 and 2 with partition 1 being committable
                await commitAllOffsets()
                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        partition: 1,
                        offset: 2,
                    })
                )

                mockConsumer.commit.mockReset()
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await ingester.sessions[`${team.id}-sid2`].flush('buffer_age')
                await commitAllOffsets()
                expect(mockConsumer.commit).toHaveBeenCalledTimes(2)
                expect(mockConsumer.commit).toHaveBeenCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        partition: 1,
                        offset: 3,
                    })
                )
                expect(mockConsumer.commit).toHaveBeenCalledWith(
                    expect.objectContaining({
                        partition: 2,
                        offset: 3,
                    })
                )
            })
        })

        describe('watermarkers', () => {
            const getSessionWaterMarks = (partition = 1) =>
                ingester.sessionHighWaterMarker.getWaterMarks(createTP(partition, consumedTopic))
            const getPersistentWaterMarks = (partition = 1) =>
                ingester.persistentHighWaterMarker.getWaterMarks(createTP(partition, consumedTopic))

            it('should update session watermarkers with flushing', async () => {
                await ingester.handleEachBatch(
                    [createMessage('sid1'), createMessage('sid2'), createMessage('sid3')],
                    noop
                )
                await expect(getSessionWaterMarks()).resolves.toEqual({})

                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await expect(getSessionWaterMarks()).resolves.toEqual({ sid1: 1 })
                await ingester.sessions[`${team.id}-sid3`].flush('buffer_age')
                await ingester.sessions[`${team.id}-sid2`].flush('buffer_age')
                await expect(getSessionWaterMarks()).resolves.toEqual({ sid1: 1, sid2: 2, sid3: 3 })
            })

            it('should update partition watermarkers when committing', async () => {
                await ingester.handleEachBatch(
                    [createMessage('sid1'), createMessage('sid2'), createMessage('sid1')],
                    noop
                )
                await ingester.sessions[`${team.id}-sid1`].flush('buffer_age')
                await commitAllOffsets()
                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)

                // all replay events should be watermarked up until the 3rd message as they HAVE been processed
                // whereas the commited kafka offset should be the 1st message as the 2nd message HAS not been processed
                const expectedWaterMarks = {
                    session_replay_console_logs_events_ingester: 3,
                    session_replay_events_ingester: 3,
                }
                if (consumeOverflow) {
                    expectedWaterMarks['session-recordings-blob-overflow'] = 1
                } else {
                    expectedWaterMarks['session-recordings-blob'] = 1
                }
                await expect(getPersistentWaterMarks()).resolves.toEqual(expectedWaterMarks)

                // sid1 should be watermarked up until the 3rd message as it HAS been processed
                await expect(getSessionWaterMarks()).resolves.toEqual({ sid1: 3 })
            })

            it('should drop events that are higher than the watermarks', async () => {
                const events = [createMessage('sid1'), createMessage('sid2'), createMessage('sid2')]

                await expect(getPersistentWaterMarks()).resolves.toEqual({})
                await ingester.handleEachBatch([events[0], events[1]], noop)
                await ingester.sessions[`${team.id}-sid2`].flush('buffer_age')
                await commitAllOffsets()
                expect(mockConsumer.commit).not.toHaveBeenCalled()
                await expect(getPersistentWaterMarks()).resolves.toEqual({
                    session_replay_console_logs_events_ingester: 2,
                    session_replay_events_ingester: 2,
                })
                await expect(getSessionWaterMarks()).resolves.toEqual({
                    sid2: 2, // only processed the second message so far
                })

                // Simulate a re-processing
                await ingester.destroySessions(Object.entries(ingester.sessions))
                await ingester.handleEachBatch(events, noop)
                expect(ingester.sessions[`${team.id}-sid2`].buffer.count).toBe(1)
                expect(ingester.sessions[`${team.id}-sid1`].buffer.count).toBe(1)
            })
        })

        describe('simulated rebalancing', () => {
            let otherIngester: SessionRecordingIngester
            jest.setTimeout(5000) // Increased to cover lock delay

            beforeEach(async () => {
                otherIngester = new SessionRecordingIngester(
                    config,
                    hub.postgres,
                    hub.objectStorage,
                    consumeOverflow,
                    undefined
                )
                await otherIngester.start()
            })

            afterEach(async () => {
                await otherIngester.stop()
            })

            /**
             * It is really hard to actually do rebalance tests against kafka, so we instead simulate the various methods and ensure the correct logic occurs
             */
            it('rebalances new consumers', async () => {
                const partitionMsgs1 = [createMessage('session_id_1', 1), createMessage('session_id_2', 1)]
                const partitionMsgs2 = [createMessage('session_id_3', 2), createMessage('session_id_4', 2)]

                mockConsumer.assignments.mockImplementation(() => [
                    createTP(1, consumedTopic),
                    createTP(2, consumedTopic),
                    createTP(3, consumedTopic),
                ])
                await ingester.handleEachBatch([...partitionMsgs1, ...partitionMsgs2], noop)

                expect(
                    Object.values(ingester.sessions).map((x) => `${x.partition}:${x.sessionId}:${x.buffer.count}`)
                ).toEqual(['1:session_id_1:1', '1:session_id_2:1', '2:session_id_3:1', '2:session_id_4:1'])

                const rebalancePromises = [
                    ingester.onRevokePartitions([createTP(2, consumedTopic), createTP(3, consumedTopic)]),
                ]

                // Should immediately be removed from the tracked sessions
                expect(
                    Object.values(ingester.sessions).map((x) => `${x.partition}:${x.sessionId}:${x.buffer.count}`)
                ).toEqual(['1:session_id_1:1', '1:session_id_2:1'])

                // Call the second ingester to receive the messages. The revocation should still be in progress meaning they are "paused" for a bit
                // Once the revocation is complete the second ingester should receive the messages but drop most of them as they got flushes by the revoke
                mockConsumer.assignments.mockImplementation(() => [
                    createTP(2, consumedTopic),
                    createTP(3, consumedTopic),
                ])
                await otherIngester.handleEachBatch([...partitionMsgs2, createMessage('session_id_4', 2)], noop)
                await Promise.all(rebalancePromises)

                // Should still have the partition 1 sessions that didnt move
                expect(
                    Object.values(ingester.sessions).map((x) => `${x.partition}:${x.sessionId}:${x.buffer.count}`)
                ).toEqual(['1:session_id_1:1', '1:session_id_2:1'])

                // Should have session_id_4 but not session_id_3 as it was flushed
                expect(
                    Object.values(otherIngester.sessions).map((x) => `${x.partition}:${x.sessionId}:${x.buffer.count}`)
                ).toEqual(['2:session_id_3:1', '2:session_id_4:1'])
            })

            it("flushes and commits as it's revoked", async () => {
                await ingester.handleEachBatch(
                    [createMessage('sid1'), createMessage('sid2'), createMessage('sid3', 2)],
                    noop
                )

                expect(readdirSync(config.SESSION_RECORDING_LOCAL_DIRECTORY + '/session-buffer-files')).toEqual([
                    expect.stringContaining(`${team.id}.sid1.`), // gz
                    expect.stringContaining(`${team.id}.sid1.`), // json
                    expect.stringContaining(`${team.id}.sid2.`), // gz
                    expect.stringContaining(`${team.id}.sid2.`), // json
                    expect.stringContaining(`${team.id}.sid3.`), // gz
                    expect.stringContaining(`${team.id}.sid3.`), // json
                ])

                const revokePromise = ingester.onRevokePartitions([createTP(1, consumedTopic)])

                expect(Object.keys(ingester.sessions)).toEqual([`${team.id}-sid3`])

                await revokePromise

                // Only files left on the system should be the sid3 ones
                expect(readdirSync(config.SESSION_RECORDING_LOCAL_DIRECTORY + '/session-buffer-files')).toEqual([
                    expect.stringContaining(`${team.id}.sid3.`), // gz
                    expect.stringContaining(`${team.id}.sid3.`), // json
                ])

                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)
                expect(mockConsumer.commit).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        topic: consumedTopic,
                        offset: 2 + 1,
                        partition: 1,
                    })
                )
            })
        })

        describe('when a team is disabled', () => {
            it('can commit even if an entire batch is disabled', async () => {
                // non-zero offset because the code can't commit offset 0
                await ingester.handleEachBatch(
                    [
                        createKafkaMessage(consumedTopic, 'invalid_token', { offset: 12 }),
                        createKafkaMessage(consumedTopic, 'invalid_token', { offset: 13 }),
                    ],
                    noop
                )
                expect(mockConsumer.commit).toHaveBeenCalledTimes(1)
                expect(mockConsumer.commit).toHaveBeenCalledWith({
                    topic: consumedTopic,
                    offset: 14,
                    partition: 1,
                })
            })
        })

        describe(
            'overflow detection',
            consumeOverflow
                ? () => {
                      return // Skip these tests when running with consumeOverflow (it's disabled)
                  }
                : () => {
                      const ingestBurst = async (count: number, size_bytes: number, timestamp_delta: number) => {
                          const first_timestamp = Date.now() - 2 * timestamp_delta * count

                          // Because messages from the same batch are reduced into a single one, we call handleEachBatch
                          // with individual messages to have better control on the message timestamp
                          for (let n = 0; n < count; n++) {
                              const message = createMessage('sid1', 1, {
                                  size: size_bytes,
                                  timestamp: first_timestamp + n * timestamp_delta,
                              })
                              await ingester.handleEachBatch([message], noop)
                          }
                      }

                      it('should not trigger overflow if under threshold', async () => {
                          await ingestBurst(10, 100, 10)
                          expect(await redisConn.exists(CAPTURE_OVERFLOW_REDIS_KEY)).toEqual(0)
                      })

                      it('should trigger overflow during bursts', async () => {
                          const expected_expiration = Math.floor(Date.now() / 1000) + 24 * 3600 // 24 hours from now, in seconds
                          await ingestBurst(10, 150_000, 10)

                          expect(await redisConn.exists(CAPTURE_OVERFLOW_REDIS_KEY)).toEqual(1)
                          expect(
                              await redisConn.zrangebyscore(
                                  CAPTURE_OVERFLOW_REDIS_KEY,
                                  expected_expiration - 10,
                                  expected_expiration + 10
                              )
                          ).toEqual([`sid1`])
                      })

                      it('should not trigger overflow during backfills', async () => {
                          await ingestBurst(10, 150_000, 150_000)
                          expect(await redisConn.exists(CAPTURE_OVERFLOW_REDIS_KEY)).toEqual(0)
                      })

                      it('should cleanup older entries when triggering', async () => {
                          await redisConn.zadd(
                              CAPTURE_OVERFLOW_REDIS_KEY,
                              'NX',
                              Date.now() / 1000 - 7000,
                              'expired:session'
                          )
                          await redisConn.zadd(
                              CAPTURE_OVERFLOW_REDIS_KEY,
                              'NX',
                              Date.now() / 1000 - 1000,
                              'not_expired:session'
                          )
                          expect(await redisConn.zrange(CAPTURE_OVERFLOW_REDIS_KEY, 0, -1)).toEqual([
                              'expired:session',
                              'not_expired:session',
                          ])

                          await ingestBurst(10, 150_000, 10)
                          expect(await redisConn.exists(CAPTURE_OVERFLOW_REDIS_KEY)).toEqual(1)
                          expect(await redisConn.zrange(CAPTURE_OVERFLOW_REDIS_KEY, 0, -1)).toEqual([
                              'not_expired:session',
                              `sid1`,
                          ])
                      })
                  }
        )

        describe('lag reporting', () => {
            it('should return the latest offsets', async () => {
                mockConsumer.queryWatermarkOffsets.mockImplementation((_topic, partition, _timeout, cb) => {
                    cb(null, { highOffset: 1000 + partition, lowOffset: 0 })
                })

                const results = await ingester.latestOffsetsRefresher.get()

                expect(results).toEqual({
                    0: 1000,
                    1: 1001,
                })
            })
        })

        describe('heartbeats', () => {
            it('it should send them whilst processing', async () => {
                const heartbeat = jest.fn()
                // non-zero offset because the code can't commit offset 0
                const partitionMsgs1 = [createMessage('session_id_1', 1), createMessage('session_id_2', 1)]
                await ingester.handleEachBatch(partitionMsgs1, heartbeat)

                // NOTE: the number here can change as we change the code. Important is that it is called a number of times
                expect(heartbeat).toBeCalledTimes(7)
            })
        })
    })

    describe('when ingester.stop is called in teardown', () => {
        describe('stop()', () => {
            const setup = async (): Promise<void> => {
                const partitionMsgs1 = [createMessage('session_id_1', 1), createMessage('session_id_2', 1)]
                await ingester.handleEachBatch(partitionMsgs1, noop)
            }

            // NOTE: This test is a sanity check for the follow up test. It demonstrates what happens if we shutdown in the wrong order
            // It doesn't reliably work though as the onRevoke is called via the kafka lib ending up with dangling promises so rather it is here as a reminder
            // demonstation for when we need it
            it.skip('shuts down with error if redis forcefully shutdown', async () => {
                await setup()

                await ingester.redisPool.drain()
                await ingester.redisPool.clear()

                // revoke, realtime unsub, replay stop
                await expect(ingester.stop()).resolves.toMatchObject([{ status: 'rejected' }, { status: 'fulfilled' }])
            })
            it('shuts down without error', async () => {
                await setup()

                // revoke, realtime unsub, replay stop, console ingestion stop
                await expect(ingester.stop()).resolves.toMatchObject([{ status: 'fulfilled' }, { status: 'fulfilled' }])
            })
        })
    })
})
