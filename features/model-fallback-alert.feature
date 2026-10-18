Feature: Model fallback alert

  Scenario: Model fallback triggers a warning alert
    Given a session whose first 30 requests were served by configured model "gpt-5.2"
    When a retry_fallback_applied event reports from "gpt-5.2" to "qwen3-coder-30b" with reason "rate limited: insufficient quota"
    Then one warning is logged naming the session, from "gpt-5.2", to "qwen3-coder-30b", and the reason
    And no further warning is logged while requests continue succeeding on the fallback model
