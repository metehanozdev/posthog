import { actions, BindLogic, connect, events, kea, path, reducers, selectors, useMountedLogic, useValues } from 'kea'
import { MOCK_NODE_PROCESS } from 'lib/constants'
import { use3000Body } from 'lib/hooks/use3000Body'
import { ToastCloseButton } from 'lib/lemon-ui/LemonToast/LemonToast'
import { SpinnerOverlay } from 'lib/lemon-ui/Spinner/Spinner'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { inAppPromptLogic } from 'lib/logic/inAppPrompt/inAppPromptLogic'
import { Slide, ToastContainer } from 'react-toastify'
import { frontendAppsLogic } from 'scenes/apps/frontendAppsLogic'
import { appScenes } from 'scenes/appScenes'
import { organizationLogic } from 'scenes/organizationLogic'
import { sceneLogic } from 'scenes/sceneLogic'
import { LoadedScene, SceneExport } from 'scenes/sceneTypes'
import { userLogic } from 'scenes/userLogic'

import { ErrorBoundary } from '~/layout/ErrorBoundary'
import { GlobalModals } from '~/layout/GlobalModals'
import { breadcrumbsLogic } from '~/layout/navigation/Breadcrumbs/breadcrumbsLogic'
import { Navigation } from '~/layout/navigation-3000/Navigation'
import { themeLogic } from '~/layout/navigation-3000/themeLogic'
import { actionsModel } from '~/models/actionsModel'
import { cohortsModel } from '~/models/cohortsModel'

import type { appLogicType } from './AppType'
import { preflightLogic } from './PreflightCheck/preflightLogic'
import { teamLogic } from './teamLogic'

window.process = MOCK_NODE_PROCESS

export const appLogic = kea<appLogicType>([
    path(['scenes', 'App']),
    connect([teamLogic, organizationLogic, frontendAppsLogic, inAppPromptLogic, actionsModel, cohortsModel]),
    actions({
        enableDelayedSpinner: true,
        ignoreFeatureFlags: true,
    }),
    reducers({
        showingDelayedSpinner: [false, { enableDelayedSpinner: () => true }],
        featureFlagsTimedOut: [false, { ignoreFeatureFlags: () => true }],
    }),
    selectors({
        showApp: [
            (s) => [
                userLogic.selectors.userLoading,
                userLogic.selectors.user,
                featureFlagLogic.selectors.receivedFeatureFlags,
                s.featureFlagsTimedOut,
                preflightLogic.selectors.preflightLoading,
                preflightLogic.selectors.preflight,
            ],
            (userLoading, user, receivedFeatureFlags, featureFlagsTimedOut, preflightLoading, preflight) => {
                return (
                    (!userLoading || user) &&
                    (receivedFeatureFlags || featureFlagsTimedOut) &&
                    (!preflightLoading || preflight)
                )
            },
        ],
    }),
    events(({ actions, cache }) => ({
        afterMount: () => {
            cache.spinnerTimeout = window.setTimeout(() => actions.enableDelayedSpinner(), 1000)
            cache.featureFlagTimeout = window.setTimeout(() => actions.ignoreFeatureFlags(), 3000)
        },
        beforeUnmount: () => {
            window.clearTimeout(cache.spinnerTimeout)
            window.clearTimeout(cache.featureFlagTimeout)
        },
    })),
])

export function App(): JSX.Element | null {
    const { showApp, showingDelayedSpinner } = useValues(appLogic)
    useMountedLogic(sceneLogic({ scenes: appScenes }))
    use3000Body()

    if (showApp) {
        return (
            <>
                <LoadedSceneLogics />
                <AppScene />
            </>
        )
    }

    return <SpinnerOverlay sceneLevel visible={showingDelayedSpinner} />
}

function LoadedSceneLogic({
    scene,
    sceneExports,
}: {
    scene: LoadedScene
    sceneExports: Record<string, SceneExport>
}): null {
    if (!sceneExports[scene.id]?.logic) {
        throw new Error('Loading scene without a logic')
    }
    useMountedLogic(
        sceneExports[scene.id]?.logic?.(sceneExports[scene.id]?.paramsToProps?.(scene.sceneParams)) ?? sceneLogic
    )
    return null
}

function LoadedSceneLogics(): JSX.Element {
    const { loadedScenes } = useValues(sceneLogic)
    const sceneExports = sceneLogic.findMounted()?.cache.sceneExports ?? {}
    return (
        <>
            {Object.entries(loadedScenes)
                .filter(([, { id }]) => !!sceneExports[id].logic)
                .map(([key, loadedScene]) => (
                    <LoadedSceneLogic key={key} scene={loadedScene} sceneExports={sceneExports} />
                ))}
        </>
    )
}

function AppScene(): JSX.Element | null {
    useMountedLogic(breadcrumbsLogic)
    const { user } = useValues(userLogic)
    const { activeScene, activeSceneExport, sceneParams, params, loadedScenes, sceneConfig } = useValues(sceneLogic)
    const { showingDelayedSpinner } = useValues(appLogic)
    const { isDarkModeOn } = useValues(themeLogic)

    const toastContainer = (
        <ToastContainer
            autoClose={6000}
            transition={Slide}
            closeOnClick={false}
            draggable={false}
            closeButton={<ToastCloseButton />}
            position="bottom-right"
            theme={isDarkModeOn ? 'dark' : 'light'}
        />
    )

    let sceneElement: JSX.Element
    if (activeSceneExport && activeScene && activeScene in loadedScenes) {
        const { component: SceneComponent } = activeSceneExport
        sceneElement = <SceneComponent user={user} {...params} />
    } else {
        sceneElement = <SpinnerOverlay sceneLevel visible={showingDelayedSpinner} />
    }

    const wrappedSceneElement = (
        <ErrorBoundary key={activeScene}>
            {activeSceneExport?.logic ? (
                <BindLogic logic={activeSceneExport.logic} props={activeSceneExport.paramsToProps?.(sceneParams) || {}}>
                    {sceneElement}
                </BindLogic>
            ) : (
                sceneElement
            )}
        </ErrorBoundary>
    )

    if (!user) {
        return sceneConfig?.onlyUnauthenticated || sceneConfig?.allowUnauthenticated ? (
            <>
                {wrappedSceneElement}
                {toastContainer}
            </>
        ) : null
    }

    return (
        <>
            <Navigation sceneConfig={sceneConfig}>{wrappedSceneElement}</Navigation>
            {toastContainer}
            <GlobalModals />
        </>
    )
}
