Feature: Model fallback alert

  Scenario: Model fallback triggers a warning alert
    Given a session whose first 30 requests were served by configured model "gpt-5.2"
    When a retry_fallback_applied event reports from "gpt-5.2" to "qwen3-coder-30b" with reason "rate limited: insufficient quota"
    Then one warning is logged naming the session, from "gpt-5.2", to "qwen3-coder-30b", and the reason
    And no further warning is logged while requests continue succeeding on the fallback model

  Scenario: Restoring the configured model re-arms fallback alerting
    Given a session with an active fallback episode on "qwen3-coder-30b"
    When an assistant_message reports the configured model "gpt-5.2" serving again
    And a later retry_fallback_applied event again reports from "gpt-5.2" to "qwen3-coder-30b"
    Then a new warning is logged

  Scenario: Fallback alert shows a banner naming both models
    Given session "cache-watch-demo" is running in a TUI with an active fallback episode from "gpt-5.2" to "qwen3-coder-30b"
    Then a red banner appears in that session naming both models
    And a TUI session without an active fallback episode shows no banner

