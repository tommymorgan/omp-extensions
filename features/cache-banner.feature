Feature: Cache collapse banner

  Scenario: Collapse shows a red banner in the affected session only
    Given session "cache-watch-demo" is running in a TUI and has an active collapse alert naming a 94%-to-58% drop with correlated contributor candidate "kizn-guidance"
    Then a red banner appears in that session's interface showing the drop and the source
    And a different TUI session without an active alert shows no banner

  Scenario: Banner clears on recovery
    Given session "cache-watch-demo" is showing the collapse banner
    When its rolling rate recovers above the absolute floor for 3 consecutive evaluations
    Then the banner is removed without restarting the session

  Scenario: Attribution diagnostics distinguish missing evidence from a candidate
    Given a watched interactive session with an active collapse episode
    When attribution has a correlated contributor, unsupported payload, chained partial coverage, no captured divergence or no matching contributor
    Then the banner distinguishes those evidence states rather than displaying generic none recorded
    And ordinary collapse recovery and the separate fallback banner keep their existing behavior
