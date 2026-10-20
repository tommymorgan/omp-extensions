Feature: Cache divergence attribution

  Scenario: Alert reports the divergence point
    Given requests 40, 41 and 42 of session "cache-watch-demo" share an identical message-prefix hash and request 43's prefix hash first differs at message index 7
    When the collapse warning fires
    Then the warning detail names request 43 and message index 7 as the divergence point

  Scenario: Alert names a request-matched contributor candidate
    Given the divergence point is request 43 of session "cache-watch-demo"
    And a context contribution from source "kizn-guidance" covers the changed text at the divergent provider prefix
    When the collapse warning fires
    Then the warning names source "kizn-guidance" as a correlated contributor candidate at request 43
    And it does not claim proof of cache-loss causation

  Scenario: Matching uses the changed occurrence rather than global text novelty
    Given identical contribution text already exists elsewhere in the previous request
    When a fresh observed contribution covers a newly changed occurrence at the divergent prefix
    Then the warning identifies that request-matched contributor candidate

  Scenario: Unmatched divergence reports no matching contributor
    Given the divergence point is request 43 of session "cache-watch-demo"
    And no eligible observed contribution matches its changed prefix
    When the collapse warning fires
    Then the warning states that no matching contributor was observed

  Scenario: Compaction is named as the cause
    Given the divergence point immediately follows a session_compact event and no context injection was recorded between them
    When the collapse warning fires
    Then the warning names the compaction as the likely cause instead of an injection

  Scenario: Codex input reports a correlated contributor candidate
    Given a session with a healthy cache baseline and a named Kizn snapshot in its request prefix
    When an included changed snapshot is sent through full Responses input and the cache rate collapses
    Then the warning identifies the actual divergence and a request-matched Kizn contributor candidate
    And the attribution is described as correlation rather than proof of cache-loss causation

  Scenario: Top-level instruction changes participate in fingerprinting
    Given a supported provider request whose message list remains unchanged
    When its top-level system or instructions prefix changes before a collapse
    Then the warning identifies the changed prefix instead of reporting that no divergence was captured

  Scenario: Unsupported and chained requests expose incomplete coverage
    Given a session with a healthy cache baseline
    When a collapse occurs on an unsupported payload or an append-only chained Responses request
    Then the diagnostic distinguishes unsupported from partial chained fingerprint coverage
    And it does not reuse an old complete-request fingerprint to invent a divergence or contributor
    And provider request boundaries still advance independently of successful extraction

  Scenario: A later publication is matched to the actual request
    Given cache-watch observes context before a Trailboss contributor publishes its snapshot
    When that snapshot appears at the changed prefix in the same session's outgoing request
    Then the warning can identify the contributor and its available version and content digest
    But a publication that is absent from the request or belongs to another session is not attributed
    And observing the publication does not accept or modify it

  Scenario: Delayed context inclusion preserves an available contribution version
    Given a versioned publication is observed before several unchanged requests
    When its custom context message with the same available version later enters the changed request prefix
    Then the warning retains that version and associates the candidate with the actual inclusion request

  Scenario: Old or unrelated contributors do not explain a later collapse
    Given a Kizn update followed by thirty healthy provider requests
    When a later collapse follows an unrelated earlier message edit
    Then the warning does not name the old Kizn update as its contributor candidate
    And a candidate outside the bounded divergence window is not reused

  Scenario: Idle publication bursts retain bounded recent evidence
    Given a watched session receives a thousand distinct publications without a provider request
    When its next changed request includes a recently published snapshot
    Then the warning can identify that recent contributor
    But the oldest observations beyond the 64-entry retention cap are no longer eligible
