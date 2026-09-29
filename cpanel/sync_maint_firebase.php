<?php
/**
 * sync_maint_firebase.php
 *
 * Mirrors the maintenance table written by submit.php into the
 * `maintRequests` node of Firebase Realtime Database, so the PNA ERP
 * (https://pnatech.com.my/supply.chain/) can display the form submissions
 * read-only.
 *
 * INSTALL
 *   1. Upload this file next to db_connect.php in /maintenance/form_aduan/
 *   2. Create firebase_secrets.php in the SAME folder (chmod 600):
 *
 *        <?php
 *        // Leave empty when the Realtime Database rules are open.
 *        $FIREBASE_DB_TOKEN = '';
 *
 *   3. Run it once by hand to seed the data, then add a cPanel cron job:
 *
 *        php /home/pnatech/public_html/maintenance/form_aduan/sync_maint_firebase.php
 *
 *      Every 5 minutes is plenty.
 *
 * DEBUG: append ?debug=1 to the URL to see errors and available extensions.
 */

$debug = isset($_GET['debug']) && $_GET['debug'] !== '';
if ($debug) {
    ini_set('display_errors', '1');
    error_reporting(E_ALL);
}

/* The table name is injected at build time to avoid encoding surprises. */
$TABLE = 'penyelenggaraan';

$FIREBASE_DB_URL = getenv('FIREBASE_DB_URL') ?: 'https://supply-chain-88a2e-default-rtdb.asia-southeast1.firebasedatabase.app';
$FIREBASE_NODE   = 'maintRequests';
$FORM_BASE_URL   = 'https://pnatech.com.my/maintenance/form_aduan/';

$FIREBASE_DB_TOKEN = getenv('FIREBASE_DB_TOKEN') ?: '';
if ($FIREBASE_DB_TOKEN === '' && file_exists(__DIR__ . '/firebase_secrets.php')) {
    require_once __DIR__ . '/firebase_secrets.php';
    if (!$FIREBASE_DB_TOKEN && isset($FIREBASE_DB_TOKEN_LOCAL)) {
        $FIREBASE_DB_TOKEN = $FIREBASE_DB_TOKEN_LOCAL;
    }
}

function log_line($msg) {
    echo '[' . date('Y-m-d H:i:s') . '] ' . $msg . "\n";
}

function debug_line($msg) {
    global $debug;
    if ($debug) {
        log_line('DEBUG  ' . $msg);
    }
}

/** Columns we would like, in display order. The script only selects the ones
 *  the table actually has, so an older or newer schema cannot break the sync.
 *  Note: the live form does NOT persist jenis_kerosakkan or masa_dikesan --
 *  submit.php only uses them for the notification email. */
$WANT_COLUMNS = array(
    'id', 'nama', 'lokasi', 'tarikh', 'kerosakkan',
    'jenis_kerosakkan', 'masa_dikesan',
    'gambar', 'status', 'completed_at', 'completed_by', 'created_at',
);

/** PUT a JSON body to Firebase. Prefers cURL, falls back to streams so this
 *  still works when the cURL extension is not enabled. */
function firebase_put($url, $json) {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_CUSTOMREQUEST  => 'PUT',
            CURLOPT_POSTFIELDS     => $json,
            CURLOPT_HTTPHEADER     => array('Content-Type: application/json'),
        ));
        $body  = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $code  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($errno) {
            return array(0, 'cURL error: ' . $error);
        }
        return array($code, (string)$body);
    }

    debug_line('cURL extension missing, using stream fallback');
    $ctx = stream_context_create(array(
        'http' => array(
            'method'        => 'PUT',
            'header'        => "Content-Type: application/json\r\n",
            'content'       => $json,
            'timeout'       => 60,
            'ignore_errors' => true,
        ),
    ));
    $body = @file_get_contents($url, false, $ctx);
    $code = 0;
    foreach ($http_response_header as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $code = (int)$m[1];
        }
    }
    if ($body === false) {
        return array(0, 'stream request failed (check allow_url_fopen)');
    }
    return array($code, $body);
}

try {
    if ($debug) {
        log_line('PHP ' . PHP_VERSION);
        log_line('mysqli: ' . (extension_loaded('mysqli') ? 'yes' : 'NO'));
        log_line('curl : ' . (function_exists('curl_init') ? 'yes' : 'NO'));
        log_line('allow_url_fopen: ' . (ini_get('allow_url_fopen') ? 'on' : 'OFF'));
    }

    /* ------------------------------------------------------------ read MySQL */

    require_once __DIR__ . '/db_connect.php';

    // Discover the real column list so the sync survives schema differences.
    $have = array();
    $colsRes = $conn->query('SHOW COLUMNS FROM `' . $TABLE . '`');
    if ($colsRes === false) {
        log_line('Cannot read columns of ' . $TABLE . ': ' . $conn->error);
        exit(1);
    }
    while ($c = $colsRes->fetch_assoc()) {
        $have[] = $c['Field'];
    }
    $colsRes->free();

    $cols = array_values(array_intersect($WANT_COLUMNS, $have));
    if (empty($cols) || !in_array('id', $cols, true)) {
        log_line('Unexpected schema. Columns found: ' . implode(', ', $have));
        exit(1);
    }
    debug_line('selecting: ' . implode(', ', $cols));

    $quoted = array();
    foreach ($cols as $c) {
        $quoted[] = '`' . $c . '`';
    }
    $sql = 'SELECT ' . implode(', ', $quoted) . ' FROM `' . $TABLE . '` ORDER BY `tarikh` DESC, `created_at` DESC';

    $result = $conn->query($sql);
    if ($result === false) {
        log_line('SQL ERROR: ' . $conn->error);
        exit(1);
    }

    $payload = array();
    while ($row = $result->fetch_assoc()) {
        $gambar = isset($row['gambar']) ? trim((string)$row['gambar']) : '';

        // Only the filename is mirrored. The photo stays in uploads/ and is
        // served straight from there, so no large blobs are duplicated into
        // the realtime database.
        $entry = array(
            'id'           => (string)$row['id'],
            'nama'         => (string)$row['nama'],
            'lokasi'       => (string)$row['lokasi'],
            'tarikh'       => (string)$row['tarikh'],
            'kerosakkan'   => (string)$row['kerosakkan'],
            'gambar'       => $gambar,
            'gambar_url'   => $gambar !== '' ? $FORM_BASE_URL . 'uploads/' . rawurlencode($gambar) : '',
            'status'       => (string)$row['status'],
        );

        if (array_key_exists('jenis_kerosakkan', $row)) {
            $entry['jenis_kerosakkan'] = (string)$row['jenis_kerosakkan'];
        } else {
            $entry['jenis_kerosakkan'] = '';
        }
        $entry['masa_dikesan'] = array_key_exists('masa_dikesan', $row) ? (string)$row['masa_dikesan'] : '';
        $entry['completed_at'] = !empty($row['completed_at']) ? (string)$row['completed_at'] : null;
        $entry['completed_by'] = !empty($row['completed_by']) ? (string)$row['completed_by'] : null;
        $entry['created_at']   = !empty($row['created_at']) ? (string)$row['created_at'] : null;

        // Realtime Database keys may not contain . # $ [ ] /
        $key = preg_replace('/[.#$\[\]\/]/', '_', (string)$row['id']);
        $payload[$key] = $entry;
    }
    $result->free();
    $conn->close();

    log_line('Read ' . count($payload) . ' record(s) from MySQL');

    /* --------------------------------------------------------- push to Firebase */

    $url = rtrim($FIREBASE_DB_URL, '/') . '/' . $FIREBASE_NODE . '.json';
    if ($FIREBASE_DB_TOKEN !== '') {
        $url .= '?auth=' . rawurlencode($FIREBASE_DB_TOKEN);
    }

    $json = json_encode($payload);
    if ($json === false) {
        log_line('json_encode failed: ' . json_last_error_msg());
        exit(1);
    }
    debug_line('payload ' . strlen($json) . ' bytes -> ' . $url);

    list($code, $body) = firebase_put($url, $json);

    if ($code === 200) {
        log_line('OK, wrote ' . count($payload) . ' record(s) to ' . $FIREBASE_NODE);
        exit(0);
    }

    log_line('FAILED HTTP ' . $code . ': ' . substr($body, 0, 500));
    if ($code === 401 || $code === 403) {
        log_line('Set FIREBASE_DB_TOKEN in firebase_secrets.php, or relax the database rules.');
    }
    if ($code === 0) {
        log_line('The request never reached Firebase. Check the PHP extensions listed above.');
    }
    exit(1);
} catch (Throwable $e) {
    log_line('FATAL: ' . $e->getMessage());
    exit(1);
}
