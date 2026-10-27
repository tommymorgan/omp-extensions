Feature: OMP slash commands in the Trailboss command palette

  Scenario: Palette lists a published omp command
    Given a trailboss plugin dir for plugin id "omp" with action "restart" titled "omp: restart" is linked and enabled
    When the command palette catalog is listed via ui.command.list
    Then an entry with title "omp: restart" and plugin identity {kind: plugin, plugin_id: "omp"} is present

  Scenario: Bridge receives selected pane context
    Given the omp plugin is linked and a pane running omp is selected
    When the palette invokes plugin action "restart"
    Then the bridge process receives HERDR_PLUGIN_ACTION_ID "restart" and HERDR_PLUGIN_CONTEXT_JSON containing the selected pane's pane_id

  Scenario: Dispatch executes the slash command in the owning instance
    Given an omp instance running the palette-commands extension
    When the bridge sends "/restart\n" to that pane through the trailboss session socket, after verifying its registry entry
    Then the omp process exec-replaces itself (PID unchanged, stack changed) while preserving session id

  Scenario: Aggregated manifest is the union of live instances
    Given omp instance A publishes command "restart" and instance B publishes command "model"
    When the aggregated manifest is regenerated
    Then it contains actions for both "omp: restart" and "omp: model"
    And regenerating after instance B exits still contains "omp: restart"

  Scenario: Argument-requiring commands publish
    Given an instance whose inventory contains argument command "tan" that requires typed work text
    When the aggregated manifest is generated
    Then an action titled "omp: tan" is present and its description carries the usage hint "<work>"

  Scenario: Palette invocation restarts the selected pane's omp
    Given two omp instances in different panes and the plugin linked with action "restart"
    When the palette invokes plugin action "restart" with pane P selected
    Then only the omp instance attached to pane P exec-replaces itself
    And the other instance is unchanged

  Scenario: Stale pane entry is rejected
    Given a registry entry whose PID no longer exists
    When the bridge resolves that pane_id
    Then no text is sent and the bridge exits nonzero with an error naming the stale pane

  Scenario: Argument command prefills the selected pane's composer
    Given an instance whose inventory includes argument command "tan" and the plugin linked with action "tan"
    When the palette invokes plugin action "tan" with pane P selected
    Then the omp attached to pane P shows "/tan " in its input composer, unsubmitted
    And no agent turn starts until the operator submits it

  Scenario: Deny-listed commands never publish
    Given the deny-list contains "quit" and an instance's inventory includes it
    When the aggregated manifest is generated
    Then no action for "omp: quit" is present

  Scenario: Instance shutdown removes its published commands
    Given instance B publishes command "model" and the manifest includes it
    When instance B shuts down and the manifest regenerates
    Then "omp: model" is absent from the manifest and other instances' actions remain

  Scenario: Killed instance's stale entries are swept
    Given a registry entry for an instance that was SIGKILLed and did not run session_shutdown
    When the cleanup sweep runs
    Then the dead entry is pruned and live instances' entries remain
