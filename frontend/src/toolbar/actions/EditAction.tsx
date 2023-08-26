import { useEffect } from 'react'
import { useActions, useValues } from 'kea'
import { Form, Input } from 'antd'
import { actionsTabLogic } from '~/toolbar/actions/actionsTabLogic'
import { StepField } from '~/toolbar/actions/StepField'
import { SelectorEditingModal } from '~/toolbar/elements/SelectorEditingModal'
import { LemonButton } from 'lib/lemon-ui/LemonButton'
import { IconClose, IconDelete, IconEdit, IconMagnifier, IconPlus } from 'lib/lemon-ui/icons'
import { posthog } from '~/toolbar/posthog'
import { getShadowRootPopoverContainer } from '~/toolbar/utils'

export function EditAction(): JSX.Element {
    const [form] = Form.useForm()

    const {
        initialValuesForForm,
        selectedActionId,
        inspectingElement,
        editingFields,
        editingSelector,
        elementsChainBeingEdited,
        editingSelectorValue,
    } = useValues(actionsTabLogic)
    const {
        selectAction,
        inspectForElementWithIndex,
        setEditingFields,
        setForm,
        saveAction,
        deleteAction,
        setElementSelector,
        editSelectorWithIndex,
    } = useActions(actionsTabLogic)

    const { getFieldValue } = form

    useEffect(() => {
        // This sucks. We're storing the antd "form" object in kea in a reducer. Dispatching an action for it.
        // That's so that the logic would be able to access the latest state of the form.
        // There's another ugly hack with a `counter` selector in the actionsTabLogic as well, check it out :P
        //
        // I tried just saving the form's state in kea via `fields` && `onFieldsChange`, but that's in a funny
        // format and doesn't update if the form is updated dynamically (`form.setFields(fields)` on inspect element).
        //
        // The solution is probably to control the form state better in the logic, for example by providing a
        // default `fields` value (it's a bit of work) and making changes against that, not through `form.setFields`.
        //
        // Thanks for reading, the next coffee is on me! / Marius
        setForm(form)
    }, [form])

    return (
        <div>
            <SelectorEditingModal
                isOpen={editingSelector !== null}
                setIsOpen={() => editSelectorWithIndex(null)}
                activeElementChain={elementsChainBeingEdited}
                startingSelector={editingSelectorValue}
                onChange={(selector) => {
                    if (selector && editingSelector !== null) {
                        posthog.capture('toolbar_manual_selector_applied', {
                            chosenSelector: selector,
                        })
                        setElementSelector(selector, editingSelector)
                    }
                }}
            />

            <div className={'flex flex-row items-center justify-between'}>
                <h1 className="uppercase font-bold text-sm mb-0">
                    {selectedActionId === 'new' ? 'New ' : 'Edit '}
                    action
                </h1>
                <LemonButton icon={<IconClose />} type="tertiary" size="small" onClick={() => selectAction(null)}>
                    Cancel
                </LemonButton>
            </div>

            <Form
                name="action_step"
                form={form}
                initialValues={initialValuesForForm}
                onFinish={saveAction}
                fields={editingFields || undefined}
                onChange={(e) => {
                    e.stopPropagation()
                }}
                onFieldsChange={(_, allFields) => {
                    setEditingFields(allFields)
                }}
            >
                <p>What did your user do?</p>
                <Form.Item
                    name="name"
                    className="action-title-field"
                    rules={[{ required: true, message: 'Please enter a name for this action!' }]}
                >
                    <Input onChange={(e) => e.stopPropagation()} placeholder="E.g: Clicked Sign Up" />
                </Form.Item>
                <Form.List name="steps">
                    {(fields, { add, remove }) => (
                        <div>
                            {fields.map((field, index) => {
                                const step = getFieldValue && getFieldValue('steps')[index]
                                return (
                                    <div key={field.key} className="action-section highlight">
                                        <div className={'flex flex-row items-center justify-between'}>
                                            <h1 className="uppercase font-bold text-sm mb-0">
                                                {index > 0 ? 'OR ' : null}Element #{index + 1}
                                            </h1>
                                            <LemonButton
                                                status="stealth"
                                                size="small"
                                                onClick={() => remove(field.name)}
                                                sideIcon={<IconDelete />}
                                            >
                                                Remove
                                            </LemonButton>
                                        </div>

                                        <div className="action-inspect">
                                            <LemonButton
                                                size="small"
                                                type={inspectingElement === index ? 'primary' : 'secondary'}
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    inspectForElementWithIndex(
                                                        inspectingElement === index ? null : index
                                                    )
                                                }}
                                                icon={<IconMagnifier />}
                                            >
                                                {step?.event === '$autocapture' ? 'Change Element' : 'Select Element'}
                                            </LemonButton>
                                        </div>

                                        {step?.event === '$autocapture' || inspectingElement === index ? (
                                            <>
                                                <StepField
                                                    field={field}
                                                    step={step}
                                                    item="selector"
                                                    label="Selector"
                                                    caption="CSS selector that uniquely identifies your element"
                                                />
                                                <div className="flex flex-row justify-end mb-2">
                                                    <LemonButton
                                                        size={'small'}
                                                        type={'secondary'}
                                                        icon={<IconEdit />}
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            posthog.capture('toolbar_manual_selector_modal_opened', {
                                                                selector: step?.selector,
                                                            })
                                                            editSelectorWithIndex(index)
                                                        }}
                                                        getTooltipPopupContainer={getShadowRootPopoverContainer}
                                                    >
                                                        Edit the selector
                                                    </LemonButton>
                                                </div>
                                                <StepField
                                                    field={field}
                                                    step={step}
                                                    item="href"
                                                    label="Link target"
                                                    caption={
                                                        <>
                                                            If your element is a link, the location that the link opens
                                                            (<code>href</code> tag)
                                                        </>
                                                    }
                                                />
                                                <StepField
                                                    field={field}
                                                    step={step}
                                                    item="text"
                                                    label="Text"
                                                    caption="Text content inside your element"
                                                />

                                                <StepField
                                                    field={field}
                                                    step={step}
                                                    item="url"
                                                    label="Page URL"
                                                    caption="Elements will match only when triggered from the URL."
                                                />
                                            </>
                                        ) : null}

                                        {index === fields.length - 1 ? (
                                            <div className={'text-right mt-4'}>
                                                <LemonButton size="small" onClick={() => add()} sideIcon={<IconPlus />}>
                                                    Add Another Element
                                                </LemonButton>
                                            </div>
                                        ) : null}
                                    </div>
                                )
                            })}
                            {fields.length === 0 ? (
                                <LemonButton size="small" type="primary" onClick={() => add()} sideIcon={<IconPlus />}>
                                    Add An Element
                                </LemonButton>
                            ) : null}
                        </div>
                    )}
                </Form.List>
                <Form.Item style={{ marginTop: 10, marginBottom: 0 }}>
                    <div className={'flex flex-row justify-between'}>
                        <LemonButton size="small" type="primary" htmlType="submit">
                            {selectedActionId === 'new' ? 'Create ' : 'Save '}
                            action
                        </LemonButton>

                        {selectedActionId !== 'new' ? (
                            <LemonButton size={'small'} status="danger" onClick={deleteAction} icon={<IconDelete />}>
                                Delete
                            </LemonButton>
                        ) : null}
                    </div>
                </Form.Item>
            </Form>
        </div>
    )
}
