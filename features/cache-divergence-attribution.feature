Feature: Cache divergence attribution

  Scenario: Alert reports the divergence point
    Given requests 40, 41 and 42 of session "cache-watch-demo" share an identical message-prefix hash and request 43's prefix hash first differs at message index 7
    When the collapse warning fires
    Then the warning detail names request 43 and message index 7 as the divergence point

  Scenario: Alert names the nearest upstream injection
    Given the divergence point is request 43 of session "cache-watch-demo"
    And a context injection from source "kizn-guidance" was recorded between requests 42 and 43
    When the collapse warning fires
    Then the warning names source "kizn-guidance" as the nearest upstream injection
