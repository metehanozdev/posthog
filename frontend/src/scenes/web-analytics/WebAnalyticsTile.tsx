import { IconGear } from '@posthog/icons'
import { useActions, useValues } from 'kea'
import { IntervalFilterStandalone } from 'lib/components/IntervalFilter'
import { useFeatureFlag } from 'lib/hooks/useFeatureFlag'
import { LemonButton } from 'lib/lemon-ui/LemonButton'
import { LemonSwitch } from 'lib/lemon-ui/LemonSwitch'
import { UnexpectedNeverError } from 'lib/utils'
import { useCallback, useMemo } from 'react'
import { countryCodeToFlag, countryCodeToName } from 'scenes/insights/views/WorldMap'
import { urls } from 'scenes/urls'
import { DeviceTab, GeographyTab, webAnalyticsLogic } from 'scenes/web-analytics/webAnalyticsLogic'

import { Query } from '~/queries/Query/Query'
import { DataTableNode, InsightVizNode, NodeKind, QuerySchema, WebStatsBreakdown } from '~/queries/schema'
import { QueryContext, QueryContextColumnComponent, QueryContextColumnTitleComponent } from '~/queries/types'
import { ChartDisplayType, GraphPointPayload, InsightLogicProps, PropertyFilterType } from '~/types'

const PercentageCell: QueryContextColumnComponent = ({ value }) => {
    if (typeof value === 'number') {
        return <span>{`${(value * 100).toFixed(1)}%`}</span>
    }
    return null
}

const NumericCell: QueryContextColumnComponent = ({ value }) => {
    return <span>{typeof value === 'number' ? value.toLocaleString() : String(value)}</span>
}

const BreakdownValueTitle: QueryContextColumnTitleComponent = (props) => {
    const { query } = props
    const { source } = query
    if (source.kind !== NodeKind.WebStatsTableQuery) {
        return null
    }
    const { breakdownBy } = source
    switch (breakdownBy) {
        case WebStatsBreakdown.Page:
            return <>Path</>
        case WebStatsBreakdown.InitialPage:
            return <>Initial Path</>
        case WebStatsBreakdown.ExitPage:
            return <>Exit Path</>
        case WebStatsBreakdown.InitialChannelType:
            return <>Initial Channel Type</>
        case WebStatsBreakdown.InitialReferringDomain:
            return <>Referring Domain</>
        case WebStatsBreakdown.InitialUTMSource:
            return <>UTM Source</>
        case WebStatsBreakdown.InitialUTMCampaign:
            return <>UTM Campaign</>
        case WebStatsBreakdown.InitialUTMMedium:
            return <>UTM Medium</>
        case WebStatsBreakdown.InitialUTMTerm:
            return <>UTM Term</>
        case WebStatsBreakdown.InitialUTMContent:
            return <>UTM Content</>
        case WebStatsBreakdown.Browser:
            return <>Browser</>
        case WebStatsBreakdown.OS:
            return <>OS</>
        case WebStatsBreakdown.DeviceType:
            return <>Device Type</>
        case WebStatsBreakdown.Country:
            return <>Country</>
        case WebStatsBreakdown.Region:
            return <>Region</>
        case WebStatsBreakdown.City:
            return <>City</>
        default:
            throw new UnexpectedNeverError(breakdownBy)
    }
}

const BreakdownValueCell: QueryContextColumnComponent = (props) => {
    const { value, query } = props
    const { source } = query
    if (source.kind !== NodeKind.WebStatsTableQuery) {
        return null
    }
    const { breakdownBy } = source

    switch (breakdownBy) {
        case WebStatsBreakdown.Country:
            if (typeof value === 'string') {
                const countryCode = value
                return (
                    <>
                        {countryCodeToFlag(countryCode)} {countryCodeToName[countryCode] || countryCode}
                    </>
                )
            }
            break
        case WebStatsBreakdown.Region:
            if (Array.isArray(value)) {
                const [countryCode, regionCode, regionName] = value
                return (
                    <>
                        {countryCodeToFlag(countryCode)} {countryCodeToName[countryCode] || countryCode} -{' '}
                        {regionName || regionCode}
                    </>
                )
            }
            break
        case WebStatsBreakdown.City:
            if (Array.isArray(value)) {
                const [countryCode, cityName] = value
                return (
                    <>
                        {countryCodeToFlag(countryCode)} {countryCodeToName[countryCode] || countryCode} - {cityName}
                    </>
                )
            }
            break
    }

    if (typeof value === 'string') {
        return <>{value}</>
    }
    return null
}

export const webStatsBreakdownToPropertyName = (
    breakdownBy: WebStatsBreakdown,
    useSessionTable: boolean
):
    | { key: string; type: PropertyFilterType.Person | PropertyFilterType.Event | PropertyFilterType.Session }
    | undefined => {
    if (!useSessionTable) {
        switch (breakdownBy) {
            case WebStatsBreakdown.Page:
                return { key: '$pathname', type: PropertyFilterType.Event }
            case WebStatsBreakdown.InitialPage:
                return { key: '$initial_pathname', type: PropertyFilterType.Person }
            case WebStatsBreakdown.ExitPage:
                return undefined
            case WebStatsBreakdown.InitialChannelType:
                return undefined
            case WebStatsBreakdown.InitialReferringDomain:
                return { key: '$initial_referring_domain', type: PropertyFilterType.Person }
            case WebStatsBreakdown.InitialUTMSource:
                return { key: '$initial_utm_source', type: PropertyFilterType.Person }
            case WebStatsBreakdown.InitialUTMCampaign:
                return { key: '$initial_utm_campaign', type: PropertyFilterType.Person }
            case WebStatsBreakdown.InitialUTMMedium:
                return { key: '$initial_utm_medium', type: PropertyFilterType.Person }
            case WebStatsBreakdown.InitialUTMContent:
                return { key: '$initial_utm_content', type: PropertyFilterType.Person }
            case WebStatsBreakdown.InitialUTMTerm:
                return { key: '$initial_utm_term', type: PropertyFilterType.Person }
            case WebStatsBreakdown.Browser:
                return { key: '$browser', type: PropertyFilterType.Event }
            case WebStatsBreakdown.OS:
                return { key: '$os', type: PropertyFilterType.Event }
            case WebStatsBreakdown.DeviceType:
                return { key: '$device_type', type: PropertyFilterType.Event }
            case WebStatsBreakdown.Country:
                return { key: '$geoip_country_code', type: PropertyFilterType.Event }
            case WebStatsBreakdown.Region:
                return { key: '$geoip_subdivision_1_code', type: PropertyFilterType.Event }
            case WebStatsBreakdown.City:
                return { key: '$geoip_city_name', type: PropertyFilterType.Event }
            default:
                throw new UnexpectedNeverError(breakdownBy)
        }
    } else {
        switch (breakdownBy) {
            case WebStatsBreakdown.Page:
                return { key: '$pathname', type: PropertyFilterType.Event }
            case WebStatsBreakdown.InitialPage:
                return { key: '$entry_pathname', type: PropertyFilterType.Session }
            case WebStatsBreakdown.ExitPage:
                return { key: '$exit_pathname', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialChannelType:
                return { key: '$channel_type', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialReferringDomain:
                return { key: '$entry_referring_domain', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialUTMSource:
                return { key: '$entry_utm_source', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialUTMCampaign:
                return { key: '$entry_utm_campaign', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialUTMMedium:
                return { key: '$entry_utm_medium', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialUTMContent:
                return { key: '$entry_utm_content', type: PropertyFilterType.Session }
            case WebStatsBreakdown.InitialUTMTerm:
                return { key: '$entry_utm_term', type: PropertyFilterType.Session }
            case WebStatsBreakdown.Browser:
                return { key: '$browser', type: PropertyFilterType.Event }
            case WebStatsBreakdown.OS:
                return { key: '$os', type: PropertyFilterType.Event }
            case WebStatsBreakdown.DeviceType:
                return { key: '$device_type', type: PropertyFilterType.Event }
            case WebStatsBreakdown.Country:
                return { key: '$geoip_country_code', type: PropertyFilterType.Event }
            case WebStatsBreakdown.Region:
                return { key: '$geoip_subdivision_1_code', type: PropertyFilterType.Event }
            case WebStatsBreakdown.City:
                return { key: '$geoip_city_name', type: PropertyFilterType.Event }
            default:
                throw new UnexpectedNeverError(breakdownBy)
        }
    }
}

export const webAnalyticsDataTableQueryContext: QueryContext = {
    columns: {
        breakdown_value: {
            renderTitle: BreakdownValueTitle,
            render: BreakdownValueCell,
        },
        bounce_rate: {
            title: 'Bounce Rate',
            render: PercentageCell,
            align: 'right',
        },
        views: {
            title: 'Views',
            render: NumericCell,
            align: 'right',
        },
        visitors: {
            title: 'Visitors',
            render: NumericCell,
            align: 'right',
        },
        average_scroll_percentage: {
            title: 'Average Scroll',
            render: PercentageCell,
            align: 'right',
        },
        scroll_gt80_percentage: {
            title: 'Deep Scroll Rate',
            render: PercentageCell,
            align: 'right',
        },
    },
}

export const WebStatsTrendTile = ({
    query,
    showIntervalTile,
    insightProps,
}: {
    query: InsightVizNode
    showIntervalTile?: boolean
    insightProps: InsightLogicProps
}): JSX.Element => {
    const { togglePropertyFilter, setInterval } = useActions(webAnalyticsLogic)
    const useSessionsTable = useFeatureFlag('SESSION_TABLE_PROPERTY_FILTERS')
    const {
        hasCountryFilter,
        deviceTab,
        hasDeviceTypeFilter,
        hasBrowserFilter,
        hasOSFilter,
        dateFilter: { interval },
    } = useValues(webAnalyticsLogic)
    const worldMapPropertyName = webStatsBreakdownToPropertyName(WebStatsBreakdown.Country, useSessionsTable)?.key
    const deviceTypePropertyName = webStatsBreakdownToPropertyName(WebStatsBreakdown.DeviceType, useSessionsTable)?.key

    const onWorldMapClick = useCallback(
        (breakdownValue: string) => {
            if (!worldMapPropertyName) {
                return
            }
            togglePropertyFilter(PropertyFilterType.Event, worldMapPropertyName, breakdownValue, {
                geographyTab: hasCountryFilter ? undefined : GeographyTab.REGIONS,
            })
        },
        [togglePropertyFilter, worldMapPropertyName]
    )

    const onDeviceTilePieChartClick = useCallback(
        (graphPoint: GraphPointPayload) => {
            if (graphPoint.seriesId == null) {
                return
            }
            const dataset = graphPoint.crossDataset?.[graphPoint.seriesId]
            if (!dataset) {
                return
            }
            const breakdownValue = dataset.breakdownValues?.[graphPoint.index]
            if (!breakdownValue) {
                return
            }
            if (!deviceTypePropertyName) {
                return
            }

            // switch to a different tab if we can, try them in this order: DeviceType Browser OS
            let newTab: DeviceTab | undefined = undefined
            if (deviceTab !== DeviceTab.DEVICE_TYPE && !hasDeviceTypeFilter) {
                newTab = DeviceTab.DEVICE_TYPE
            } else if (deviceTab !== DeviceTab.BROWSER && !hasBrowserFilter) {
                newTab = DeviceTab.BROWSER
            } else if (deviceTab !== DeviceTab.OS && !hasOSFilter) {
                newTab = DeviceTab.OS
            }

            togglePropertyFilter(PropertyFilterType.Event, deviceTypePropertyName, breakdownValue, {
                deviceTab: newTab,
            })
        },
        [togglePropertyFilter, deviceTypePropertyName, deviceTab, hasDeviceTypeFilter, hasBrowserFilter, hasOSFilter]
    )

    const context = useMemo((): QueryContext => {
        return {
            ...webAnalyticsDataTableQueryContext,
            chartRenderingMetadata: {
                [ChartDisplayType.WorldMap]: {
                    countryProps: (countryCode, values) => {
                        return {
                            onClick:
                                values && (values.count > 0 || values.aggregated_value > 0)
                                    ? () => onWorldMapClick(countryCode)
                                    : undefined,
                        }
                    },
                },
                [ChartDisplayType.ActionsPie]: {
                    onSegmentClick: onDeviceTilePieChartClick,
                },
            },
            insightProps: {
                ...insightProps,
                query,
            },
        }
    }, [onWorldMapClick, insightProps])

    return (
        <div className="border rounded bg-bg-light flex-1 flex flex-col">
            {showIntervalTile && (
                <div className="flex flex-row items-center justify-end m-2 mr-4">
                    <div className="flex flex-row items-center">
                        <span className="mr-2">Group by</span>
                        <IntervalFilterStandalone
                            interval={interval}
                            onIntervalChange={setInterval}
                            options={[
                                { value: 'hour', label: 'Hour' },
                                { value: 'day', label: 'Day' },
                                { value: 'week', label: 'Week' },
                                { value: 'month', label: 'Month' },
                            ]}
                        />
                    </div>
                </div>
            )}
            <Query query={query} readOnly={true} context={context} />
        </div>
    )
}

export const WebStatsTableTile = ({
    query,
    breakdownBy,
    insightProps,
    showPathCleaningControls,
}: {
    query: DataTableNode
    breakdownBy: WebStatsBreakdown
    insightProps: InsightLogicProps
    showPathCleaningControls?: boolean
}): JSX.Element => {
    const { togglePropertyFilter, setIsPathCleaningEnabled } = useActions(webAnalyticsLogic)
    const { isPathCleaningEnabled } = useValues(webAnalyticsLogic)
    const useSessionsTable = useFeatureFlag('SESSION_TABLE_PROPERTY_FILTERS')

    const { key, type } = webStatsBreakdownToPropertyName(breakdownBy, useSessionsTable) || {}

    const onClick = useCallback(
        (breakdownValue: string) => {
            if (!key || !type) {
                return
            }
            togglePropertyFilter(type, key, breakdownValue)
        },
        [togglePropertyFilter, type, key]
    )

    const context = useMemo((): QueryContext => {
        const rowProps: QueryContext['rowProps'] = (record: unknown) => {
            if (
                (breakdownBy === WebStatsBreakdown.InitialPage || breakdownBy === WebStatsBreakdown.Page) &&
                isPathCleaningEnabled
            ) {
                // if the path cleaning is enabled, don't allow toggling a path by clicking a row, as this wouldn't
                // work due to the order that the regex and filters are applied
                return {}
            }

            const breakdownValue = getBreakdownValue(record, breakdownBy)
            if (breakdownValue === undefined) {
                return {}
            }
            return {
                onClick: key && type ? () => onClick(breakdownValue) : undefined,
            }
        }
        return {
            ...webAnalyticsDataTableQueryContext,
            insightProps,
            rowProps,
        }
    }, [onClick, insightProps])

    const pathCleaningSettingsUrl = urls.settings('project-product-analytics', 'path-cleaning')
    return (
        <div className="border rounded bg-bg-light flex-1">
            {showPathCleaningControls && (
                <div className="flex flex-row items-center justify-end m-2 mr-4">
                    <div className="flex flex-row items-center space-x-2">
                        <LemonSwitch
                            label={
                                <div className="flex flex-row space-x-2">
                                    <span>Enable path cleaning</span>
                                    <LemonButton
                                        icon={<IconGear />}
                                        type="tertiary"
                                        status="alt"
                                        size="small"
                                        noPadding={true}
                                        tooltip="Edit path cleaning settings"
                                        to={pathCleaningSettingsUrl}
                                    />
                                </div>
                            }
                            checked={isPathCleaningEnabled}
                            onChange={setIsPathCleaningEnabled}
                            className="h-full"
                        />
                    </div>
                </div>
            )}
            <Query query={query} readOnly={true} context={context} />
        </div>
    )
}

const getBreakdownValue = (record: unknown, breakdownBy: WebStatsBreakdown): string | undefined => {
    if (typeof record !== 'object' || !record || !('result' in record)) {
        return undefined
    }
    const result = record.result
    if (!Array.isArray(result)) {
        return undefined
    }
    // assume that the first element is the value
    const breakdownValue = result[0]

    switch (breakdownBy) {
        case WebStatsBreakdown.Country:
            if (Array.isArray(breakdownValue)) {
                return breakdownValue[0]
            }
            break
        case WebStatsBreakdown.Region:
            if (Array.isArray(breakdownValue)) {
                return breakdownValue[1]
            }
            break
        case WebStatsBreakdown.City:
            if (Array.isArray(breakdownValue)) {
                return breakdownValue[1]
            }
            break
    }

    if (typeof breakdownValue !== 'string') {
        return undefined
    }
    return breakdownValue
}

export const WebQuery = ({
    query,
    showIntervalSelect,
    showPathCleaningControls,
    insightProps,
}: {
    query: QuerySchema
    showIntervalSelect?: boolean
    showPathCleaningControls?: boolean
    insightProps: InsightLogicProps
}): JSX.Element => {
    if (query.kind === NodeKind.DataTableNode && query.source.kind === NodeKind.WebStatsTableQuery) {
        return (
            <WebStatsTableTile
                query={query}
                breakdownBy={query.source.breakdownBy}
                insightProps={insightProps}
                showPathCleaningControls={showPathCleaningControls}
            />
        )
    }
    if (query.kind === NodeKind.InsightVizNode) {
        return <WebStatsTrendTile query={query} showIntervalTile={showIntervalSelect} insightProps={insightProps} />
    }

    return <Query query={query} readOnly={true} context={{ ...webAnalyticsDataTableQueryContext, insightProps }} />
}
