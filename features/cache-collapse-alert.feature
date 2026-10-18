Feature: Cache collapse alert

  Scenario: Cache collapse triggers a warning alert
    Given a session "cache-watch-demo" with a baseline cache-read rate of 94% established over its first 20 provider responses
    When its rolling 5-response cache-read rate stays below 70% and more than 15 points below baseline for 3 consecutive evaluations with no compaction, switch, or retry event in between
    Then a warning is logged naming session "cache-watch-demo", its baseline 94%, the current rolling rate, and both crossed thresholds
    And the warning is logged once for the collapse, not once per response
