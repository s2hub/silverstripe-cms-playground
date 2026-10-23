<?php

// Imports the content of demo.silverstripe.org's MySQL dump (.reset/db_reset.sql) into the playground's SQLite
// database, after `sake db:build` has created the tables.
//
// Only content tables are imported (pages, files, site settings, link tracking). Members, passwords, groups and
// login data are left out: the playground has its own admin. The dump's INSERTs list no columns, so the column
// order is taken from its CREATE TABLE statements; columns the SQLite table does not have are dropped.
//
// Usage: php import-demo-content.php <dump.sql> <database.sqlite>

const TABLES = '/^(SiteTree|HomePage|ErrorPage|RedirectorPage|VirtualPage|File)(_Live|_Versions)?$'
    . '|^(SiteConfig|SiteTreeLink|SiteTree_LinkTracking|SiteTree_ImageTracking|FileLink)$/';

[, $dumpFile, $databaseFile] = $argv;

$dump = file_get_contents($dumpFile);
$db = new SQLite3($databaseFile);
$db->enableExceptions(true);

// Column order of every table in the dump.
$dumpColumns = [];
preg_match_all('/^CREATE TABLE `([^`]+)` \((.*?)^\)/ms', $dump, $tables, PREG_SET_ORDER);
foreach ($tables as [, $table, $body]) {
    preg_match_all('/^\s+`([^`]+)`/m', $body, $columns);
    $dumpColumns[$table] = $columns[1];
}

/**
 * Parses the value list of a MySQL INSERT: (1,'a',NULL),(2,'b\'s',3.5) into rows.
 */
function parseRows(string $values): array
{
    $rows = [];
    $row = [];
    $length = strlen($values);
    $escapes = ['0' => "\0", 'b' => "\x08", 'n' => "\n", 'r' => "\r", 't' => "\t", 'Z' => "\x1a"];

    for ($i = 0; $i < $length; $i++) {
        $char = $values[$i];

        if ($char === "'") {
            $string = '';
            for ($i++; $i < $length; $i++) {
                $char = $values[$i];
                if ($char === '\\') {
                    $next = $values[++$i];
                    $string .= $escapes[$next] ?? $next;
                } elseif ($char === "'" && ($values[$i + 1] ?? '') === "'") {
                    $string .= "'";
                    $i++;
                } elseif ($char === "'") {
                    break;
                } else {
                    $string .= $char;
                }
            }
            $row[] = $string;
        } elseif ($char === ')') {
            $rows[] = $row;
            $row = [];
        } elseif ($char === '(' || $char === ',' || ctype_space($char)) {
            continue;
        } else {
            // NULL or a number: up to the next separator.
            preg_match('/[^,)]+/A', $values, $match, 0, $i);
            $i += strlen($match[0]) - 1;
            $row[] = $match[0] === 'NULL' ? null : $match[0];
        }
    }

    return $rows;
}

$db->exec('BEGIN');
$imported = [];

preg_match_all('/^INSERT INTO `([^`]+)` VALUES (.*);$/m', $dump, $inserts, PREG_SET_ORDER);
foreach ($inserts as [, $table, $values]) {
    if (!preg_match(TABLES, $table)) {
        continue;
    }

    $sqliteColumns = [];
    $result = $db->query('PRAGMA table_info("' . $table . '")');
    while ($column = $result->fetchArray(SQLITE3_ASSOC)) {
        $sqliteColumns[$column['name']] = true;
    }

    if (!$sqliteColumns) {
        fwrite(STDERR, "Skipped $table: not in the SQLite database\n");
        continue;
    }

    if (!isset($imported[$table])) {
        // Replace the default records db:build made (Home, About Us, Contact Us, ...).
        $db->exec('DELETE FROM "' . $table . '"');
        $imported[$table] = 0;
    }

    $columns = array_values(array_filter($dumpColumns[$table], fn ($name) => isset($sqliteColumns[$name])));
    $statement = $db->prepare(sprintf(
        'INSERT INTO "%s" (%s) VALUES (%s)',
        $table,
        implode(', ', array_map(fn ($name) => '"' . $name . '"', $columns)),
        implode(', ', array_fill(0, count($columns), '?'))
    ));

    foreach (parseRows($values) as $row) {
        $values = array_combine($dumpColumns[$table], $row);
        $statement->reset();
        foreach ($columns as $index => $name) {
            $statement->bindValue($index + 1, $values[$name], $values[$name] === null ? SQLITE3_NULL : SQLITE3_TEXT);
        }
        $statement->execute();
        $imported[$table]++;
    }
}

$db->exec('COMMIT');

foreach ($imported as $table => $count) {
    echo "$table: $count rows\n";
}
