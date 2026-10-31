// Run the suite in-process: `node --test` spawns a child process whose piped
// stdio is unavailable under the DSH file sandbox (EPERM). Importing the test
// modules directly keeps node:test's reporter and all assertions in this
// process, which the bounded runner owns.
import './recents.test.js';
import './activity.test.js';
import './pins.test.js';
import './chrome.test.js';
import './panel.test.js';
