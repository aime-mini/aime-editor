//! The window Aime shows while it starts, and the handover to the editor.
//!
//! The main window is configured hidden, so until session 25 it was shown the
//! moment Rust got going - blank, because the webview had not painted yet. The
//! splash takes that gap and makes it the greeting: a small transparent window
//! with its own page (`splash.html`, its own Vite entry so it carries none of
//! the editor's 4.4 MB of Monaco), replaced by the editor as soon as the first
//! screen is on glass.
//!
//! Three things can end it, and exactly one of them wins:
//! the frontend saying it is ready, the user asking to skip, or the timer that
//! refuses to let a picture hold the editor hostage.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::window_cmds;

/// The splash window's label - the same one `capabilities/splash.json` names.
const LABEL: &str = "splash";

/// Logical size of the card: wide rather than tall, because the words sit on
/// the left and the character portrait, when there is one, stands on the right.
const SIZE: (f64, f64) = (720.0, 400.0);

/// How long the splash stays once it is actually on screen.
///
/// A warm start reaches `app_ready` in a few hundred milliseconds, and a
/// greeting that appears and vanishes inside that reads as a glitch. This is a
/// floor, not a budget: a cold start passes it long before the editor is usable,
/// and anyone who finds it slow can press a key to skip it.
///
/// Four seconds, because there is something to watch: the character's whole loop
/// is four (`scripts/portrait/render.html`) - she notices you, waves, winks,
/// glances at the wordmark and nods - and the portrait fades in over the first
/// second of it. At 1.4 s a warm start showed a hand halfway up and then took
/// her away; at 3 s the last beat was still being cut off. The frontend spends the same
/// three seconds loading the editor's own bundle rather than idling - see the
/// startup effect in `src/App.tsx` - so the window that replaces the greeting is
/// a finished editor, not a shell that fills in afterwards.
const MIN_VISIBLE: Duration = Duration::from_millis(4000);

/// The longest the splash may hold the editor back.
///
/// If the frontend never reports ready - a crash on boot, a chunk that failed to
/// load - the editor still has to appear, so that whatever went wrong is visible
/// in the window instead of hidden behind a picture.
///
/// Generous on purpose. A release build reports ready in well under a second, so
/// this is never reached there; under `tauri dev` the editor's first load is the
/// dev server transforming 4.4 MB of Monaco, and measured on this machine that
/// alone passed eight seconds. A cap tuned to the release case turns the
/// greeting off exactly where it is most useful.
const MAX_WAIT: Duration = Duration::from_secs(20);

/// Holds the greeting up for as long as this says, in milliseconds.
///
/// `AIME_SPLASH_HOLD_MS=25000 aime` keeps it on screen for twenty-five seconds.
/// A card that is only ever up for a second and a half is hard to judge and
/// harder to show someone, and this is the whole of what makes that possible.
const HOLD_VAR: &str = "AIME_SPLASH_HOLD_MS";

/// The floor the greeting is held to - the default, unless `HOLD_VAR` says more.
fn minimum_visible() -> Duration {
    std::env::var(HOLD_VAR)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(MIN_VISIBLE, Duration::from_millis)
}

/// The longest the page may ask for on top of the minimum - see `splash_hold`.
///
/// The page is trusted about its own audio, not about the editor's launch: a
/// number that arrived wrong, or a file that turned out to be an hour long,
/// cannot hold the editor for more than this.
const MAX_HOLD: Duration = Duration::from_secs(8);

/// Slack over the hold, so the backstop never cuts a deliberate hold short.
const CAP_SLACK: Duration = Duration::from_secs(5);

/// When the backstop fires: late enough to cover a slow first load, and never
/// before whatever hold was asked for has been served - including the longest
/// the greeting may ask for.
fn cap(minimum: Duration) -> Duration {
    let over_hold = minimum.saturating_add(MAX_HOLD).saturating_add(CAP_SLACK);
    if over_hold > MAX_WAIT {
        over_hold
    } else {
        MAX_WAIT
    }
}

/// What the splash knows about itself: when it appeared, and whether the
/// handover has already happened.
#[derive(Default)]
pub struct SplashState(Mutex<Handover>);

#[derive(Default)]
struct Handover {
    /// `None` until the page reports it has painted - see `splash_shown`.
    shown_at: Option<Instant>,
    /// The page asked to stay up until here - see `splash_hold`.
    hold_until: Option<Instant>,
    done: bool,
}

impl Handover {
    /// True exactly once. Whoever gets it performs the handover; everyone else
    /// arrived second and must do nothing, or the editor would be re-maximized
    /// under the user's hands.
    fn claim(&mut self) -> bool {
        !std::mem::replace(&mut self.done, true)
    }

    /// How much of the minimum is still owed at `now`.
    ///
    /// Nothing is owed while the card is not on screen: the wait exists so a
    /// greeting is readable, and there is nothing to read yet. Whatever the page
    /// asked for on top of that is owed either way - it is talking, and it is the
    /// only side that knows how long the sentence is.
    fn remaining(&self, now: Instant, minimum: Duration) -> Duration {
        let floor = match self.shown_at {
            None => Duration::ZERO,
            Some(shown_at) => minimum.saturating_sub(now.saturating_duration_since(shown_at)),
        };
        let asked = self
            .hold_until
            .map_or(Duration::ZERO, |until| until.saturating_duration_since(now));
        floor.max(asked)
    }
}

impl SplashState {
    /// Recovers a poisoned lock instead of giving up on it: a panic in another
    /// thread must never be the reason the editor fails to appear.
    fn locked(&self) -> MutexGuard<'_, Handover> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Opens the splash and arms the timer that will replace it regardless.
///
/// Unattended runs get no splash at all: those tests drive a real window, and a
/// second webview would only give the driver another context to attach to.
pub fn start(app: &AppHandle) {
    if window_cmds::unattended() {
        app.state::<SplashState>().locked().done = true;
        show_editor(app);
        return;
    }

    // Shown as soon as it exists, and deliberately not waiting to be told the
    // page has painted.
    //
    // It used to wait, to avoid a possible white frame. Measured under
    // `tauri dev` (2026-08-27) that cost far more than it saved: the dev server
    // was busy transforming the editor's own 4.4 MB of Monaco, the splash page
    // waited behind it for over eight seconds, `splash_shown` never arrived in
    // time, and the greeting never appeared at all. Nothing about a window whose
    // job is to be early may depend on a bundler being free.
    //
    // Transparency needs no extra feature on Windows. A macOS build would also
    // need `macos-private-api`, which is not enabled here because nothing ships
    // for macOS yet.
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("splash.html".into()))
        .title("Aime")
        .inner_size(SIZE.0, SIZE.1)
        .center()
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // The greeting is audio the user never clicked to start, and Chromium
        // blocks exactly that. Passing browser arguments replaces the ones wry
        // passes by default, so they are repeated here rather than lost.
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection              --autoplay-policy=no-user-gesture-required",
        )
        .build();

    if let Err(err) = built {
        // A greeting is not worth an app that never opens.
        eprintln!("[splash] window failed, starting without it: {err}");
        hand_over(app);
        return;
    }
    // The clock starts now. If the page later reports that it has painted, that
    // reading replaces this one - see `splash_shown`.
    app.state::<SplashState>().locked().shown_at = Some(Instant::now());

    let app = app.clone();
    let backstop = cap(minimum_visible());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(backstop).await;
        hand_over(&app);
    });
}

/// The page has painted: this is when the greeting became readable.
///
/// The window is already on screen by now, so the only thing this changes is
/// where the minimum time is measured from - which is the difference between
/// "the card was up for 1.4 seconds" and "the window was".
#[tauri::command]
pub fn splash_shown(app: AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return; // already handed over - there is nothing left to time
    };
    // Asked for again here rather than relied upon from the builder: without
    // focus the "Esc to skip" the card offers is a lie, and measured
    // 2026-08-27 the window was not the foreground window until it was asked.
    if let Err(err) = window.set_focus() {
        eprintln!("[splash] set_focus failed: {err}");
    }
    app.state::<SplashState>().locked().shown_at = Some(Instant::now());
}

/// The page needs the card up for `ms` longer than the minimum would give it.
///
/// This is the spoken greeting asking for room to finish: the audio file's length
/// is known to the page and to nobody else, and a greeting cut off mid-sentence
/// is worse than a start that took another half second. Only ever extends - a
/// second caller cannot shorten what the first asked for.
#[tauri::command]
pub fn splash_hold(app: AppHandle, ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms.min(MAX_HOLD.as_millis() as u64));
    let state = app.state::<SplashState>();
    let mut handover = state.locked();
    if handover.hold_until.is_none_or(|current| current < until) {
        handover.hold_until = Some(until);
    }
}

/// A key or a click on the splash: skip whatever is left of the minimum.
#[tauri::command]
pub fn splash_skip(app: AppHandle) {
    hand_over(&app);
}

/// The frontend has painted its first screen. Hands over once the greeting has
/// had its minimum time on screen.
#[tauri::command]
pub async fn app_ready(app: AppHandle) {
    // Asked again after every wait, not once before the first.
    //
    // The editor is often ready before the greeting has finished loading, so the
    // page's `splash_hold` can arrive while this is already asleep - and a debt
    // read once is a debt that misses it. Measured: the voice was cut off mid
    // sentence exactly this way. `MAX_HOLD` bounds what the page can ask for, so
    // this cannot spin.
    loop {
        let remaining = {
            let state = app.state::<SplashState>();
            let owed = state.locked().remaining(Instant::now(), minimum_visible());
            owed // the guard is dropped here: it must not be held across the await
        };
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(remaining).await;
    }
    hand_over(&app);
}

/// Closes the splash and shows the editor - at most once, whoever asks first.
fn hand_over(app: &AppHandle) {
    if !app.state::<SplashState>().locked().claim() {
        return;
    }
    if let Some(splash) = app.get_webview_window(LABEL) {
        if let Err(err) = splash.close() {
            eprintln!("[splash] close failed: {err}");
        }
    }
    show_editor(app);
}

fn show_editor(app: &AppHandle) {
    match app.get_webview_window("main") {
        // Configured hidden; this sizes it to the real monitor work area,
        // maximizes and shows it (see window_cmds::fit_and_maximize).
        Some(window) => window_cmds::fit_and_maximize(&window),
        None => eprintln!("[splash] no main window to hand over to"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_caller_hands_over() {
        let mut handover = Handover::default();
        assert!(handover.claim(), "the first caller performs the handover");
        assert!(!handover.claim(), "the second caller must not repeat it");
        assert!(!handover.claim());
    }

    /// A hold asked for on the command line must not be ended by the backstop
    /// that exists for a broken frontend.
    #[test]
    fn the_backstop_never_cuts_a_deliberate_hold_short() {
        assert_eq!(cap(MIN_VISIBLE), MAX_WAIT, "the default hold sits well inside it");
        assert_eq!(
            cap(Duration::from_secs(10)),
            Duration::from_secs(23),
            "the greeting may ask for MAX_HOLD on top, and the backstop leaves room for it"
        );
        assert_eq!(
            cap(Duration::from_secs(40)),
            Duration::from_secs(53),
            "a hold past the backstop moves the backstop, not the hold"
        );
    }

    #[test]
    fn a_hold_the_page_asked_for_outlives_the_minimum() {
        let now = Instant::now();
        let handover = Handover {
            shown_at: Some(now),
            hold_until: Some(now + Duration::from_millis(4500)),
            done: false,
        };
        // The floor alone would let go at 3s; the greeting has 4.5s to say.
        assert_eq!(
            handover.remaining(now, Duration::from_secs(3)),
            Duration::from_millis(4500),
        );
        // And it never shortens the floor either.
        let quiet = Handover {
            shown_at: Some(now),
            hold_until: Some(now + Duration::from_millis(500)),
            done: false,
        };
        assert_eq!(
            quiet.remaining(now, Duration::from_secs(3)),
            Duration::from_secs(3)
        );
    }

    #[test]
    fn a_splash_still_off_screen_is_owed_no_time() {
        let handover = Handover::default();
        assert_eq!(
            handover.remaining(Instant::now(), MIN_VISIBLE),
            Duration::ZERO,
            "there is nothing to read yet, so there is nothing to wait for"
        );
    }

    #[test]
    fn the_wait_is_what_is_left_of_the_minimum() {
        let now = Instant::now();
        let handover = Handover {
            shown_at: Some(now - Duration::from_millis(400)),
            hold_until: None,
            done: false,
        };
        assert_eq!(
            handover.remaining(now, Duration::from_millis(1000)),
            Duration::from_millis(600)
        );
    }

    /// A start slower than the minimum must not be charged for it twice - the
    /// greeting has already been read by the time the editor is ready.
    #[test]
    fn a_slow_start_waits_no_longer() {
        let now = Instant::now();
        let handover = Handover {
            shown_at: Some(now - Duration::from_secs(5)),
            hold_until: None,
            done: false,
        };
        assert_eq!(
            handover.remaining(now, Duration::from_millis(1400)),
            Duration::ZERO
        );
    }
}
