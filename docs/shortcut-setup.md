# Apple Shortcut setup

Create the Shortcut on iPhone first, then enable it for Apple Watch.

## Shortcut actions

Name the shortcut something Siri can hear reliably, for example `Tell Jay`.

1. Add `Dictate Text`.
2. Add `Set Variable`; name it `message`.
3. Add `If`: `message` has no value.
4. Inside that branch, add `Speak Text` with `No message captured`, then `Stop This Shortcut`.
5. Add `Dictionary` with:
   - `message`: `message`
   - `source`: `siri_watch`
   - `device_name`: `Apple Watch`
   - `shortcut_name`: `Tell Jay`
   - `captured_at`: current date formatted as ISO 8601
6. Add `Get Contents of URL`.
7. Set URL to `https://your-public-bridge.example.com/shortcuts/message`.
8. Set Method to `POST`.
9. Add headers:
   - `Authorization`: `Bearer your-long-random-token`
   - `Content-Type`: `application/json`
10. Set Request Body to `JSON` and pass the dictionary.
11. Parse the response dictionary and `Speak Text` using the `spoken` value.

## Apple Watch

In the Shortcut details on iPhone, turn on `Show on Apple Watch`.

You can then run it from:

- Siri: `Hey Siri, Tell Jay`;
- the Shortcuts app on Apple Watch;
- a watch-face complication;
- the Action Button on Apple Watch Ultra models.

## Siri behavior

Siri generally does not pass arbitrary free-form text after the shortcut name as one clean utterance. The reliable interaction is:

1. Say `Hey Siri, Tell Jay`.
2. Wait for dictation.
3. Speak the message.
4. Let the shortcut POST the transcript.
