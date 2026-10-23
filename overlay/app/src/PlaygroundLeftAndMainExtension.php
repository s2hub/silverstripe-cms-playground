<?php

use SilverStripe\Core\Extension;
use SilverStripe\View\Requirements;

/**
 * CMS adjustments for the playground.
 *
 * The CMS loads the scripts a PJAX response asks for (X-Include-JS, e.g. the combined TinyMCE file) with
 * synchronous XHRs. In the playground, every request is answered by PHP in a worker of the page, through the service
 * worker; while a synchronous XHR blocks the page, Chrome sends such a request past the service worker to the web
 * server, which does not have the file. Loading them asynchronously keeps their order: the CMS loads one after the
 * other anyway. jQuery's own synchronous script loading (global: false) stays as it is.
 */
class PlaygroundLeftAndMainExtension extends Extension
{
    protected function onAfterInit(): void
    {
        Requirements::customScript(<<<'JS'
            window.jQuery && jQuery.ajaxPrefilter('script', function (options) {
                if (options.global !== false) {
                    options.async = true;
                }
            });
            JS, 'playground-async-scripts');
    }
}
