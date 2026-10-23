<?php

// The playground's own module: settings that make Silverstripe work in PHP compiled to WebAssembly, kept out of app/
// so the code editor shows the demo's code only.

use SilverStripe\SQLite\SQLite3SchemaManager;

// dev/build in the browser runs while the session's queries are still open on the same SQLite connection, and
// SQLite refuses VACUUM then ("cannot VACUUM - SQL statements in progress").
SQLite3SchemaManager::$vacuum = false;
