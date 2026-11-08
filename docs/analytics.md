# Product analytics

The desktop app uses `posthog-node` from the Electron main process. Events are
queued asynchronously, use a random installation-scoped distinct ID, do not
create PostHog person profiles, and disable IP geolocation.

## Desktop events

| Journey | Events |
| --- | --- |
| Lifecycle | `app_launched`, `app_quit` |
| Discovery | `tray_menu_opened`, `window_opened`, `window_closed`, `onboarding_step_viewed`, `onboarding_completed` |
| Reading | `read_requested`, `read_rejected`, `selection_capture_finished`, `reading_started`, `reading_synthesis_completed`, `reading_failed`, `reading_stopped` |
| Playback | `reading_playback_started`, `reading_playback_state_changed`, `reading_playback_completed`, `overlay_interaction` |
| Preferences | `setting_changed`, `voice_list_completed`, `voice_preview_completed`, `voice_search_used` |
| Account | `account_action_completed`, `billing_opened` |
| Reliability | `shortcut_registration_checked`, `shortcut_registration_changed`, `shortcut_registration_recovered`, `shortcut_registration_refreshed`, `accessibility_prompt_opened` |
| Updates | `update_check_completed`, `update_download_opened` |
| Browser extension | `extension_read_requested`, `extension_read_completed`, `extension_read_failed` |
| Open at login | `open_at_login_prompt_shown`, `open_at_login_prompt_responded` |

Each event is emitted at the main-process boundary that owns the completed
action. Renderer-originated events pass through the same strict catalog and
property validators before reaching PostHog.

## Desktop privacy settings

Only the schemas in `src/analytics.js` may reach PostHog. The app records
coarse operational facts such as action surface, provider, normalized outcome,
character/segment counts, safe durations, playback state, and configuration
category.

The app never records:

- Selected or clipboard text, rich HTML, page title, URL, or browser origin.
- Email address, service token, ElevenLabs/Fish key, PostHog token, or password.
- Voice IDs or voice names.
- Free-form error messages or arbitrary renderer-provided strings.

Unknown events, properties, enum values, and out-of-range numbers are dropped.
Set `POSTHOG_DISABLED=true` to turn analytics off entirely.

## Suggested PostHog views

- Activation funnel: `app_launched` → `read_requested` →
  `selection_capture_finished` success → `reading_playback_started`.
- Fallback health: read-request counts by `trigger`, plus selection failures by
  `reason` and shortcut events by `all_registered`.
- Reading success: `reading_started` to `reading_playback_completed`, broken
  down by `provider` and `character_count`.
- Feature adoption: `setting_changed` by `setting_name`, overlay interactions,
  voice search/preview, and extension reads.
- Reliability: update failures, synthesis failures, and extension failures by
  normalized `error_name` and `reason`.

## iOS events

Filter PostHog by `platform = ios` to see iPhone and iPad activity. This client shares event names with the desktop app. On iOS, `window_opened` means a screen became visible, and `overlay_interaction` records actions in the reader.

| Journey | Events | Properties |
| --- | --- | --- |
| Lifecycle | `app_launched`, `app_foregrounded`, `app_backgrounded` | Platform and app version |
| Navigation | `window_opened` | `surface` is `sign_in`, `compose`, `reader` or `settings` |
| Account | `account_action_completed` | `action` is `login`, `logout`, `restore` or `expired`. A restore with no saved token has `outcome = no_session` |
| Input | `text_pasted`, `read_requested`, `read_rejected` | A paste records the action alone. A read request records `character_count`. An empty request records `reason = empty` |
| Speech | `reading_started`, `reading_synthesis_completed`, `reading_failed`, `reading_stopped` | Reads started include `segment_count`. Failures include a fixed `reason` category and a `partial` flag |
| Playback | `reading_playback_started`, `reading_playback_state_changed`, `reading_playback_completed`, `overlay_interaction` | `playback_state` is `playing` or `paused`. `interaction` is `seek` or `replay` |
| Preferences | `setting_changed`, `voice_preview_completed`, `voice_list_completed` | `setting_name` is `voice`, `speed`, `stability` or `font_size`. Previews and lists report an `outcome`. Lists also report `voice_count` |

The app attaches a random installation ID, event UUID, timestamp, and validated app version. Count distinct IDs as installations. Several customers can share one installation, and one customer can have several installations. A background-to-foreground transition differs from a cold launch. `reading_synthesis_completed` means audio has finished arriving. `reading_playback_completed` means playback reached the end.

### iOS privacy

The catalog permits enumerated actions, outcomes, bounded counts and a partial-read flag. Events exclude email, credentials, balances, passage text, clipboard contents, voice names and IDs, raw error messages, and audio. The analytics client makes a dedicated HTTPS request to PostHog US with IP geolocation and person-profile processing disabled. It does not use cookies or session replay. The authenticated speech service separately processes reading requests and records account usage to meter credits. [iOS event catalog](../ios/TristrFlow/Core/ProductAnalytics.swift)

The privacy manifest declares Device ID and Product Interaction for analytics. Activity is associated with the installation ID. Apple’s tracking flags are false, since the app does not share these events for cross-company advertising or ad measurement. [Privacy manifest](../ios/TristrFlow/PrivacyInfo.xcprivacy) · [Apple’s privacy definitions](https://developer.apple.com/app-store/app-privacy-details/)

### Verify iOS delivery

A normal build running on a physical device sends to the project shared with desktop. To verify ingestion, note the time, cold-launch the app and open a different screen. Look in PostHog for `app_launched` and `window_opened` with matching `platform`, `app_version`, timestamp and installation ID. The device log records the batch size and HTTP status when PostHog acknowledges the request. The local queue retains up to 100 events, keeps event UUIDs and timestamps across retries, and discards permanently rejected batches. [Delivery implementation](../ios/TristrFlow/Core/AnalyticsDelivery.swift)

A simulator running a Debug UI test can post only to a test fixture on `http://127.0.0.1` via `TRISTR_TEST_ANALYTICS_URL`. Simulator Release builds and physical XCTest processes disable production capture. Inspect the fixture for individual actions and properties. The delivery tests exercise retries, stable event and installation IDs, bounded storage, and rejection of remote fixture URLs. [Analytics tests](../ios/TristrFlowTests/ProductAnalyticsTests.swift) · [Reader UI fixture](../ios/TristrFlowUITests/ReadAloudUITests.swift)
