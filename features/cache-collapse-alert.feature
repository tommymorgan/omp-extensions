Feature: Cache collapse alert

  Scenario: Cache collapse triggers a warning alert
    Given a session "cache-watch-demo" with a baseline cache-read rate of 94% established over its first 20 provider responses
    When its rolling 5-response cache-read rate stays below 70% and more than 15 points below baseline for 3 consecutive evaluations with no compaction, switch, or retry event in between
    Then a warning is logged naming session "cache-watch-demo", its baseline 94%, the current rolling rate, and both crossed thresholds
    And the warning is logged once for the collapse, not once per response

  Scenario: Benign compaction reset does not alert
    Given a session "cache-watch-demo" with a baseline cache-read rate of 94%
    When its rolling rate drops below both thresholds for 2 evaluations immediately after a session_compact event and then recovers above 85%
    Then no collapse warning is logged

  Scenario: Recovery re-arms detection
    Given a session that already logged a collapse warning and whose rolling rate recovered above 85% for 10 responses
    When a second collapse stays below both thresholds for 3 consecutive evaluations
    Then a second collapse warning is logged

  Scenario: Cold session does not alert
    Given a session with only 4 recorded provider responses
    When its rolling cache-read rate reads 55%
    Then no collapse warning is logged because no baseline is established
