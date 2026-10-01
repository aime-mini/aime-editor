//! Opens a web page the way a person would - a real webview, at a window size
//! chosen for it - and lets a script measure what came up.
//!
//! What gets measured is the frontend's business (`lib/layoutGate.ts`); this
//! only opens the page where nobody can see it and carries the answer back.
//! The answer travels in the page's own URL fragment, which the webview
//! reports to us: a page served by a project under test gets no IPC to Aime at
//! all, so a hostile or buggy page can do nothing with it but answer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, PhysicalPosition, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::window_cmds::PARKED_AT;

static PROBE_COUNTER: AtomicU64 = AtomicU64::new(1);

/// How often the script is run again while the page is still settling.
const POLL: Duration = Duration::from_millis(300);

/// What the script puts before its answer in the fragment: `#aime-probe=…`.
const ANSWER_PREFIX: &str = "aime-probe=";

/// Opens `url` in a webview of `width` × `height` logical pixels, parked off
/// the desktop, and runs `script` in it until the script leaves an answer -
/// handed back exactly as it stands in the fragment, still percent-encoded.
#[tauri::command]
pub async fn page_probe(
    app: AppHandle,
    url: String,
    width: f64,
    height: f64,
    script: String,
    timeout_ms: u64,
) -> Result<String, String> {
    let target = Url::parse(&url).map_err(|err| format!("Not an address: {url} ({err})"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(format!("Only a web page can be measured, not {url}"));
    }
    let label = format!("page-probe-{}", PROBE_COUNTER.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
        .inner_size(width, height)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|err| format!("Could not open a window for {url}: {err}"))?;

    // Parked first and shown after, the way the e2e window is: measured
    // 2026-10-01, the builder's own `position` was ignored and the window came
    // up on the desktop. Shown at all because a hidden webview stops rendering;
    // never focused, because the keyboard belongs to whoever is at it.
    let parked = window
        .set_position(PhysicalPosition::new(PARKED_AT.0, PARKED_AT.1))
        .and_then(|()| fit_to_width(&window, width))
        .and_then(|()| window.show());
    let answer = match parked {
        Ok(()) => wait_for_answer(&window, &script, Duration::from_millis(timeout_ms)).await,
        Err(err) => Err(format!(
            "Could not park the window for {url} off the desktop: {err}"
        )),
    };
    if let Err(err) = window.destroy() {
        eprintln!("[page_probe] could not close the window for {url}: {err}");
    }
    answer
}

/// Makes the page as wide as asked even where the window cannot be.
///
/// Windows keeps a window inside the screen it is on: measured on a 1920-pixel
/// monitor at 150 %, a window asked for 1440 logical pixels came out at 1283.
/// Zoomed out by the shortfall, the page lays out at the width asked for -
/// what a browser's device mode does - and the media queries see that width.
fn fit_to_width(window: &WebviewWindow, width: f64) -> tauri::Result<()> {
    let got = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?)
        .width;
    if got + 1.0 >= width {
        return Ok(());
    }
    window.set_zoom(got / width)
}

async fn wait_for_answer(window: &WebviewWindow, script: &str, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
        // Fire and forget: until the page has loaded the script answers
        // nothing, and the next round asks again.
        if let Err(err) = window.eval(script) {
            eprintln!("[page_probe] the script could not run yet: {err}");
            continue;
        }
        let current = window
            .url()
            .map_err(|err| format!("The page's address is unreadable: {err}"))?;
        if let Some(answer) = answer_in(&current) {
            return Ok(answer.to_string());
        }
    }
    Err(format!("The page did not answer within {} s", timeout.as_secs()))
}

/// The script's answer, when the fragment carries one.
fn answer_in(url: &Url) -> Option<&str> {
    url.fragment()?.strip_prefix(ANSWER_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::{answer_in, Url};

    fn url(text: &str) -> Url {
        Url::parse(text).expect("a valid test URL")
    }

    #[test]
    fn the_answer_is_read_from_the_fragment_as_it_stands() {
        let probed = url("http://127.0.0.1:4173/cart#aime-probe=%7B%22width%22%3A375%7D");
        assert_eq!(answer_in(&probed), Some("%7B%22width%22%3A375%7D"));
    }

    #[test]
    fn a_page_s_own_fragment_is_not_an_answer() {
        assert_eq!(answer_in(&url("http://127.0.0.1:4173/#/cart")), None);
        assert_eq!(answer_in(&url("http://127.0.0.1:4173/cart")), None);
    }
}
