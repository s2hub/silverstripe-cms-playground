<?php

// Exports the playground's site as an ordinary Silverstripe project to run with ddev (see php-worker.js):
//
// - the files git would track: without vendor/, caches, the SQLite database, exposed resources, the theme installed by
//   Composer and the playground's own module; composer.json and composer.lock as the project has them (the build
//   adds silverstripe/sqlite3 to the ones in use);
// - content/dump.sql: the content of the database as MySQL INSERTs (the tables come from dev/build);
// - content/assets/: the uploaded files (a Silverstripe project does not track public/assets in git);
// - .ddev/config.playground.yaml, .ddev/playground-setup.sh and .ddev/playground-content.php: on the first
//   `ddev start`, composer install, dev/build, then the content and the files are loaded;
// - .git/: a repository with one commit of all of it.
//
// Input: /tmp/export-project.json with root, database, zip, folder, message and time. Output: the zip.

$settings = json_decode(file_get_contents('/tmp/export-project.json'), true);
$root = $settings['root'];

/** Paths (relative to the project) that are not part of the project. */
const EXCLUDE = '#^(vendor|silverstripe-cache|database|playground|\.playground|_resources|public/_resources|public/_graphql'
    . '|themes/startup-theme|\.graphql-generated)(/|$)|^\.env$|^composer\.(json|lock)$#';

/** Generated files in public/assets, made again by dev/build or when needed. */
const GENERATED_ASSETS = '#^(_tinymce/|error-\d+\.html$)#';

/** The files public/assets keeps in git (see its .gitignore). */
const ASSETS_IN_GIT = ['.gitignore', '.htaccess', 'web.config'];

/** @var array<string, array{content: string, executable: bool}> path => file, the project as exported */
$files = [];

$add = function (string $path, string $content, bool $executable = false) use (&$files) {
    $files[$path] = ['content' => $content, 'executable' => $executable];
};

$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));

foreach ($iterator as $file) {
    if (!$file->isFile()) {
        continue;
    }

    $path = substr($file->getPathname(), strlen($root) + 1);

    if (preg_match(EXCLUDE, $path)) {
        continue;
    }

    if (str_starts_with($path, 'public/assets/')) {
        $asset = substr($path, strlen('public/assets/'));

        if (in_array($asset, ASSETS_IN_GIT, true)) {
            $add($path, file_get_contents($file->getPathname()));
        } elseif (!preg_match(GENERATED_ASSETS, $asset)) {
            $add('content/assets/' . $asset, file_get_contents($file->getPathname()));
        }

        continue;
    }

    $add($path, file_get_contents($file->getPathname()));
}

foreach (['composer.json', 'composer.lock'] as $name) {
    $add($name, file_get_contents("$root/.playground/$name"));
}

$add('content/dump.sql', mysqlDump($settings['database']));

// The project's own name, so it can run next to a checkout of the site it came from.
$add('.ddev/config.playground.yaml', "# Added by the export from the Silverstripe Playground: the project's name, the database settings, and\n"
    . "# the setup on the first start.\nname: {$settings['folder']}\n" . <<<'YAML'
web_environment:
  - SS_DATABASE_CLASS=MySQLDatabase
  - SS_DATABASE_SERVER=db
  - SS_DATABASE_USERNAME=db
  - SS_DATABASE_PASSWORD=db
  - SS_DATABASE_NAME=db
  - SS_ENVIRONMENT_TYPE=dev
  - SS_DEFAULT_ADMIN_USERNAME=admin
  - SS_DEFAULT_ADMIN_PASSWORD=password
hooks:
  post-start:
    - exec: bash .ddev/playground-setup.sh

YAML);

$add('.ddev/playground-setup.sh', <<<'BASH'
#!/bin/bash
# Sets up this site, exported from the Silverstripe Playground, on `ddev start` (see config.playground.yaml): installs
# the dependencies, and while the database is empty, builds it and loads the content and the uploaded files.
set -euo pipefail
cd /var/www/html

if [ ! -d vendor ]; then
    composer install --no-interaction
fi

if php .ddev/playground-content.php is-empty; then
    vendor/bin/sake db:build --flush
    php .ddev/playground-content.php load
    if [ -d content/assets ]; then
        cp -a content/assets/. public/assets/
    fi
    echo 'Loaded the content exported from the Silverstripe Playground.'
fi

BASH, true);

$add('.ddev/playground-content.php', <<<'PHP'
<?php

// The database of this site, for .ddev/playground-setup.sh. It connects with the settings of
// config.playground.yaml, without the mysql client (whose TLS defaults vary).
//
//   php .ddev/playground-content.php is-empty  exits with 0 when the database has no tables yet
//   php .ddev/playground-content.php load      runs content/dump.sql

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$db = new mysqli(
    getenv('SS_DATABASE_SERVER'),
    getenv('SS_DATABASE_USERNAME'),
    getenv('SS_DATABASE_PASSWORD'),
    getenv('SS_DATABASE_NAME')
);
$db->set_charset('utf8mb4');

switch ($argv[1] ?? '') {
    case 'is-empty':
        exit($db->query('SHOW TABLES')->num_rows === 0 ? 0 : 1);

    case 'load':
        $db->multi_query(file_get_contents(dirname(__DIR__) . '/content/dump.sql'));

        do {
            $db->store_result();
        } while ($db->more_results() && $db->next_result());

        exit(0);

    default:
        fwrite(STDERR, "Usage: php .ddev/playground-content.php is-empty|load\n");
        exit(2);
}

PHP);

ksort($files, SORT_STRING);

$zip = new ZipArchive();
$zip->open($settings['zip'], ZipArchive::CREATE | ZipArchive::OVERWRITE);

foreach ($files as $path => $file) {
    addToZip($zip, $settings['folder'] . '/' . $path, $file['content'], $file['executable']);
}

foreach (gitRepository($files, $settings['message'], $settings['time']) as $path => $content) {
    addToZip($zip, $settings['folder'] . '/.git/' . $path, $content, false);
}

$zip->close();

function addToZip(ZipArchive $zip, string $name, string $content, bool $executable): void
{
    $zip->addFromString($name, $content);
    $zip->setExternalAttributesName($name, ZipArchive::OPSYS_UNIX, ($executable ? 0100755 : 0100644) << 16);
}

/**
 * The rows of every table as MySQL statements. Each table is emptied first: dev/build fills some with defaults.
 */
function mysqlDump(string $database): string
{
    $db = new SQLite3($database, SQLITE3_OPEN_READONLY);
    $quote = function ($value): string {
        if ($value === null) {
            return 'NULL';
        }

        if (is_int($value) || is_float($value)) {
            return (string) $value;
        }

        return "'" . strtr($value, ["\\" => "\\\\", "'" => "\\'", "\0" => "\\0", "\n" => "\\n", "\r" => "\\r", "\x1a" => "\\Z"]) . "'";
    };
    $sql = "-- The content of a site exported from the Silverstripe Playground.\n"
        . "-- Load it after dev/build has created the tables (see .ddev/playground-setup.sh).\n"
        . "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\nSET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n";
    $tables = $db->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");

    while ($table = $tables->fetchArray(SQLITE3_NUM)) {
        $name = $table[0];
        $sql .= "\nTRUNCATE TABLE `$name`;\n";
        $rows = $db->query('SELECT * FROM "' . $name . '"');
        $batch = [];
        $columns = null;

        while ($row = $rows->fetchArray(SQLITE3_ASSOC)) {
            $columns ??= '(`' . implode('`, `', array_keys($row)) . '`)';
            $batch[] = '(' . implode(', ', array_map($quote, $row)) . ')';

            if (count($batch) === 100) {
                $sql .= "INSERT INTO `$name` $columns VALUES\n" . implode(",\n", $batch) . ";\n";
                $batch = [];
            }
        }

        if ($batch) {
            $sql .= "INSERT INTO `$name` $columns VALUES\n" . implode(",\n", $batch) . ";\n";
        }
    }

    return $sql . "\nSET FOREIGN_KEY_CHECKS = 1;\n";
}

/**
 * A git repository with one commit of the files on branch main: loose objects, the ref and an index, so the working
 * tree is clean right away.
 *
 * @return array<string, string> path in .git/ => content
 */
function gitRepository(array $files, string $message, int $time): array
{
    $repository = [
        'HEAD' => "ref: refs/heads/main\n",
        'config' => "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
        'description' => "Exported from the Silverstripe Playground\n",
    ];
    $object = function (string $type, string $content) use (&$repository): string {
        $data = "$type " . strlen($content) . "\0" . $content;
        $hash = sha1($data);
        $repository['objects/' . substr($hash, 0, 2) . '/' . substr($hash, 2)] = gzcompress($data);

        return $hash;
    };

    // The folders as nested arrays: name => file, or name => [folder].
    $tree = [];
    $blobs = [];

    foreach ($files as $path => $file) {
        $blobs[$path] = $object('blob', $file['content']);
        $node = &$tree;

        foreach (explode('/', dirname($path)) as $folder) {
            if ($folder !== '.') {
                $node[$folder] ??= [];
                $node = &$node[$folder];
            }
        }

        $node[basename($path)] = ['blob' => $blobs[$path], 'executable' => $file['executable']];
        unset($node);
    }

    $writeTree = function (array $entries) use (&$writeTree, $object): string {
        $sorted = [];

        foreach ($entries as $name => $entry) {
            $isFile = isset($entry['blob']) && is_string($entry['blob']);
            // Git sorts folders as if their names ended with a slash.
            $sorted[$isFile ? $name : "$name/"] = $isFile
                ? ($entry['executable'] ? '100755' : '100644') . " $name\0" . hex2bin($entry['blob'])
                : "40000 $name\0" . hex2bin($writeTree($entry));
        }

        ksort($sorted, SORT_STRING);

        return $object('tree', implode('', $sorted));
    };

    $author = "Silverstripe Playground <playground@silverstripe-playground.invalid> $time +0000";
    $commit = $object('commit', 'tree ' . $writeTree($tree) . "\nauthor $author\ncommitter $author\n\n$message\n");
    $repository['refs/heads/main'] = "$commit\n";

    // The index (version 2): the committed files with their hashes. The stat data is unknown here; git refreshes it
    // on the first `git status`.
    $index = 'DIRC' . pack('NN', 2, count($files));

    foreach ($files as $path => $file) {
        $entry = pack('NNNNNNNNNN', $time, 0, $time, 0, 0, 0, $file['executable'] ? 0100755 : 0100644, 0, 0, strlen($file['content']))
            . hex2bin($blobs[$path])
            . pack('n', min(strlen($path), 0xFFF))
            . $path;
        $index .= $entry . str_repeat("\0", 8 - (strlen($entry) % 8));
    }

    $repository['index'] = $index . sha1($index, true);

    return $repository;
}
