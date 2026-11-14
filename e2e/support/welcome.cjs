/**
 * Loads the current workspace's page again, on the welcome screen.
 *
 * A page that loads again reopens the folder its workspace had open - as it
 * must when the dev server reloads every page after the machine slept - so the
 * workspace is first told it has nothing open, which is what closing the
 * folder tells it.
 */
async function reloadOnWelcome() {
  await browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke("workspace_register", { folder: null }).then(done, done);
  });
  await browser.refresh();
}

module.exports = { reloadOnWelcome };
