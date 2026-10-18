Feature: Cache collapse banner

  Scenario: Collapse shows a red banner in the affected session only
    Given session "cache-watch-demo" is running in a TUI and has an active collapse alert naming a 94%-to-58% drop caused by source "kizn-guidance"
    Then a red banner appears in that session's interface showing the drop and the source
    And a different TUI session without an active alert shows no banner

  Scenario: Banner clears on recovery
    Given session "cache-watch-demo" is showing the collapse banner
    When its rolling rate recovers above the absolute floor for 3 consecutive evaluations
    Then the banner is removed without restarting the session
