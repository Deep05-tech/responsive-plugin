<?php
/**
 * Plugin Name: Elementor Responsive Agent Bridge
 * Plugin URI: https://github.com/elementor-responsive-agent/bridge
 * Description: REST API bridge for Elementor Responsive Agent to audit and optimize responsive layouts.
 * Version: 1.0.0
 * Author: Elementor Responsive Agent Team
 * License: GPL-2.0+
 * Text Domain: era-bridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

define( 'ERA_BRIDGE_VERSION', '1.0.0' );
define( 'ERA_BRIDGE_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ERA_BRIDGE_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

// Phase 1 Safety Gate: All write routes are strictly disabled by default
if ( ! defined( 'ERA_ENABLE_WRITES' ) ) {
	define( 'ERA_ENABLE_WRITES', false );
}

require_once ERA_BRIDGE_PLUGIN_DIR . 'includes/class-era-engine.php';
require_once ERA_BRIDGE_PLUGIN_DIR . 'includes/class-era-rest-api.php';
require_once ERA_BRIDGE_PLUGIN_DIR . 'includes/class-era-admin.php';
require_once ERA_BRIDGE_PLUGIN_DIR . 'includes/class-era-chat-widget.php';

add_action( 'rest_api_init', function () {
	$api = new ERA_REST_API();
	$api->register_routes();
} );

if ( is_admin() ) {
	$admin = new ERA_Admin();
	$admin->init();
}

$chat_widget = new ERA_Chat_Widget();
$chat_widget->init();
