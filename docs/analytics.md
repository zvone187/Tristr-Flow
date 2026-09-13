# Product analytics

Tristr Flow uses `posthog-node` from the Electron main process. Events are
queued asynchronously, use a random installation-scoped distinct ID, do not
create PostHog person profiles, and disable IP geolocation.

## Event taxonomy

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

## Privacy contract

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
