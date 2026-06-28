#!/usr/bin/env php
<?php

declare(strict_types=1);

error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', '0');

require __DIR__ . '/../../../bootstrap.php';

D3R::initialiseScript(null, 'local');

if (!in_array('--debug', $argv, true)) {
    D3R_Debug::disable();
}

$includeHidden = !in_array('--visible-only', $argv, true);
$absolute = in_array('--absolute', $argv, true);
$baseUrl = getArgValue($argv, '--base-url') ?: '';
$routes = [];
$sources = [];
$warnings = [];
$tabs = [];
$tabsFile = SITE_ROOT . '/config/admin_tabs.php';

if (is_readable($tabsFile)) {
    require $tabsFile;
}

try {
    $tree = D3R_SiteTree::getInstance()->getJsTree();
    collectSiteTreeRoutes($tree, [], $routes, $includeHidden, $absolute, $baseUrl);
    $sources[] = 'D3R_SiteTree::getJsTree';
} catch (Throwable $exception) {
    $warnings[] = 'D3R SiteTree dynamic route extraction failed: ' . $exception->getMessage();
}

try {
    $tabs = loadAdminTabs($tabs, $warnings);
    collectAdminTabRoutes($tabs, [], $routes, $absolute, $baseUrl);
    $sources[] = 'config/admin_tabs.php and provider getAdminTabs';
} catch (Throwable $exception) {
    $warnings[] = 'Admin tab route extraction failed: ' . $exception->getMessage();
}

usort($routes, static function (array $left, array $right): int {
    return strcmp($left['url'], $right['url']);
});

$routes = array_values(array_reduce($routes, static function (array $carry, array $route): array {
    $carry[$route['url']] = $route;

    return $carry;
}, []));

echo json_encode([
    'source' => implode(', ', $sources),
    'sources' => $sources,
    'warnings' => $warnings,
    'generatedAt' => D3R_DateTime::now()->toSqlString(),
    'count' => count($routes),
    'routes' => $routes,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;

/**
 * Collect CP routes from a jsTree node.
 *
 * @param array $node
 * @param array $parents
 * @param array $routes
 * @param bool $includeHidden
 * @param bool $absolute
 * @param string $baseUrl
 * @return void
 */
function collectSiteTreeRoutes(
    array $node,
    array $parents,
    array &$routes,
    bool $includeHidden,
    bool $absolute,
    string $baseUrl
): void {
    $hidden = !empty($node['a_attr']['data-hidden']);
    $href = $node['a_attr']['href'] ?? '';

    if ($href && ($includeHidden || !$hidden)) {
        $routes[] = buildRoute(
            (string) ($node['text'] ?? ''),
            normaliseRouteUrl((string) $href, $absolute, $baseUrl),
            (string) ($node['id'] ?? ''),
            $hidden,
            array_values(array_filter([...$parents, (string) ($node['text'] ?? '')])),
            'site-tree'
        );
    }

    foreach (($node['children'] ?? []) as $child) {
        if (is_array($child)) {
            collectSiteTreeRoutes(
                $child,
                array_values(array_filter([...$parents, (string) ($node['text'] ?? '')])),
                $routes,
                $includeHidden,
                $absolute,
                $baseUrl
            );
        }
    }
}

/**
 * Load configured and provider-supplied admin tabs.
 *
 * @param array $tabs
 * @param array $warnings
 * @return array
 */
function loadAdminTabs(array $tabs, array &$warnings): array
{
    try {
        $tabs = D3R::container()->get('providers')->getAdminTabs($tabs);
    } catch (Throwable $exception) {
        $warnings[] = 'Provider admin tabs could not be merged: ' . $exception->getMessage();
    }

    return is_array($tabs) ? $tabs : [];
}

/**
 * Collect CP routes from an admin tabs array.
 *
 * @param array $tabs
 * @param array $parents
 * @param array $routes
 * @param bool $absolute
 * @param string $baseUrl
 * @return void
 */
function collectAdminTabRoutes(
    array $tabs,
    array $parents,
    array &$routes,
    bool $absolute,
    string $baseUrl
): void {
    foreach ($tabs as $key => $value) {
        $title = adminTabTitle($key, $value);
        $path = array_values(array_filter([...$parents, $title]));

        if (is_string($key) && str_starts_with($key, '/cp') && !str_contains($key, '{')) {
            $routes[] = buildRoute(
                $title,
                normaliseRouteUrl($key, $absolute, $baseUrl),
                '',
                false,
                $path,
                'admin-tabs'
            );
        }

        if (is_array($value)) {
            if (!empty($value['url']) && is_string($value['url']) && str_starts_with($value['url'], '/cp')) {
                $routes[] = buildRoute(
                    $title,
                    normaliseRouteUrl($value['url'], $absolute, $baseUrl),
                    '',
                    false,
                    $path,
                    'admin-tabs'
                );
            }

            foreach (['subitems', 'items', 'children'] as $childKey) {
                if (!empty($value[$childKey]) && is_array($value[$childKey])) {
                    collectAdminTabRoutes($value[$childKey], $path, $routes, $absolute, $baseUrl);
                }
            }
        }
    }
}

/**
 * Build a route entry.
 *
 * @param string $title
 * @param string $url
 * @param string $id
 * @param bool $hidden
 * @param array $path
 * @param string $source
 * @return array
 */
function buildRoute(
    string $title,
    string $url,
    string $id,
    bool $hidden,
    array $path,
    string $source
): array {
    return [
        'title' => $title,
        'url' => $url,
        'id' => $id,
        'hidden' => $hidden,
        'path' => $path,
        'source' => $source,
    ];
}

/**
 * Get the human title for an admin tab entry.
 *
 * @param string|int $key
 * @param mixed $value
 * @return string
 */
function adminTabTitle(string|int $key, mixed $value): string
{
    if (is_array($value) && !empty($value['title'])) {
        return (string) $value['title'];
    }

    if (is_string($value)) {
        return $value;
    }

    return is_string($key) ? trim(str_replace(['-', '_', '/cp/'], ' ', $key)) : '';
}

/**
 * Normalise a route URL for JSON output.
 *
 * @param string $href
 * @param bool $absolute
 * @param string $baseUrl
 * @return string
 */
function normaliseRouteUrl(string $href, bool $absolute, string $baseUrl): string
{
    if (!$absolute) {
        return $href;
    }

    if (!$baseUrl) {
        $baseUrl = rtrim((string) D3R::config()->site->url, '/');
    }

    return rtrim($baseUrl, '/') . '/' . ltrim($href, '/');
}

/**
 * Get a CLI argument value.
 *
 * @param array $argv
 * @param string $name
 * @return string|null
 */
function getArgValue(array $argv, string $name): ?string
{
    $index = array_search($name, $argv, true);

    if ($index === false || empty($argv[$index + 1])) {
        return null;
    }

    return (string) $argv[$index + 1];
}
