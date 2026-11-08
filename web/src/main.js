// The Silverstripe Playground on its own: the full playground of the engine (see engine/app.js).

import { mountPlayground } from '../../engine/app.js';

/** The site with the tutorials, linked from the toolbar. */
const TUTORIALS = 'https://exploresilverstripe.com/';

mountPlayground(document.querySelector('#app'), { tutorials: TUTORIALS });
