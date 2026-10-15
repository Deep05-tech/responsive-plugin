<?php
/**
 * Admin page controller for ERA Bridge.
 * Displays interactive in-browser auditing, simulation, 1-click fix, and backup/restore controls.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ERA_Admin {

	public function init() {
		add_action( 'admin_menu', array( $this, 'add_admin_menu' ) );
		add_action( 'admin_post_era_restore_backup', array( $this, 'handle_admin_restore' ) );
		add_action( 'wp_ajax_era_restore_backup', array( $this, 'handle_admin_restore' ) );
		add_action( 'wp_ajax_era_run_audit', array( $this, 'handle_ajax_audit' ) );
		add_action( 'wp_ajax_era_run_simulate', array( $this, 'handle_ajax_simulate' ) );
		add_action( 'wp_ajax_era_apply_fix', array( $this, 'handle_ajax_apply_fix' ) );
	}

	public function add_admin_menu() {
		add_menu_page(
			__( 'ERA Responsive', 'era-bridge' ),
			__( 'ERA Responsive', 'era-bridge' ),
			'edit_pages',
			'era-dashboard',
			array( $this, 'render_admin_page' ),
			'dashicons-smartphone',
			30
		);

		add_submenu_page(
			'era-dashboard',
			__( 'Dashboard & Pages', 'era-bridge' ),
			__( 'Dashboard', 'era-bridge' ),
			'edit_pages',
			'era-dashboard',
			array( $this, 'render_admin_page' )
		);

		add_submenu_page(
			'era-dashboard',
			__( 'Safety Backups', 'era-bridge' ),
			__( 'Backups & Restore', 'era-bridge' ),
			'edit_pages',
			'era-backups',
			array( $this, 'render_backups_page' )
		);
	}

	/**
	 * Find the absolute path to Node binary.
	 */
	private function get_node_bin() {
		$candidates = array(
			'/home/uday/.nvm/versions/node/v22.22.3/bin/node',
			'/usr/local/bin/node',
			'/usr/bin/node',
		);
		foreach ( $candidates as $bin ) {
			if ( file_exists( $bin ) && is_executable( $bin ) ) {
				return $bin;
			}
		}
		$detected = trim( (string) shell_exec( 'which node 2>/dev/null' ) );
		if ( ! empty( $detected ) ) {
			return $detected;
		}
		return 'node';
	}

	/**
	 * Get paths to Node CLI, Agent directory, and candidate CSS.
	 */
	private function get_agent_paths( $page_id = 0 ) {
		$plugin_dir = defined( 'ERA_BRIDGE_PLUGIN_DIR' ) ? ERA_BRIDGE_PLUGIN_DIR : plugin_dir_path( __FILE__ ) . '../';
		$root_dir   = dirname( dirname( untrailingslashit( $plugin_dir ) ) );
		$agent_dir  = $root_dir . '/agent';
		$cli_path   = $agent_dir . '/dist/cli.js';
		$node_bin   = $this->get_node_bin();
		$node_dir   = dirname( $node_bin );

		// Determine best candidate CSS for the given page
		if ( in_array( intval( $page_id ), array( 521, 522, 523, 524 ) ) ) {
			$css_path = $root_dir . '/candidates/template-responsive-fix.css';
		} else {
			$css_path = $root_dir . '/candidates/final-fix.css';
			if ( ! file_exists( $css_path ) ) {
				$css_path = $root_dir . '/candidates/template-responsive-fix.css';
			}
		}

		return array(
			'agent_dir' => $agent_dir,
			'cli_path'  => $cli_path,
			'css_path'  => $css_path,
			'node_bin'  => $node_bin,
			'node_dir'  => $node_dir,
		);
	}

	/**
	 * AJAX Handler: Run in-browser audit for a page.
	 */
	public function handle_ajax_audit() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user capability.' ), 403 );
		}

		check_ajax_referer( 'era_admin_nonce', 'nonce' );

		$page_id = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		if ( ! $page_id ) {
			wp_send_json_error( array( 'message' => 'Invalid page ID.' ), 400 );
		}

		$paths = $this->get_agent_paths( $page_id );
		if ( ! file_exists( $paths['cli_path'] ) ) {
			wp_send_json_error( array( 'message' => 'Agent CLI not built at ' . $paths['cli_path'] ), 500 );
		}

		$cmd = sprintf(
			'export PATH=%s:"$PATH:/usr/local/bin:/usr/bin:/bin" && cd %s && %s %s audit -p %d 2>&1',
			escapeshellarg( $paths['node_dir'] ),
			escapeshellarg( $paths['agent_dir'] ),
			escapeshellarg( $paths['node_bin'] ),
			escapeshellarg( $paths['cli_path'] ),
			$page_id
		);

		$output = shell_exec( $cmd );

		$report_file = $paths['agent_dir'] . '/output/' . $page_id . '/report.json';
		if ( file_exists( $report_file ) ) {
			$report_raw = file_get_contents( $report_file );
			$report_json = json_decode( $report_raw, true );
			if ( $report_json ) {
				wp_send_json_success( array(
					'mode'      => 'audit',
					'page_id'   => $page_id,
					'summary'   => isset( $report_json['summary'] ) ? $report_json['summary'] : null,
					'viewports' => array(
						'mobile'  => array(
							'issues'       => isset( $report_json['viewports']['mobile']['issues'] ) ? count( $report_json['viewports']['mobile']['issues'] ) : 0,
							'scrollWidth'  => isset( $report_json['viewports']['mobile']['scrollWidth'] ) ? $report_json['viewports']['mobile']['scrollWidth'] : 0,
							'hasOverflow'  => ! empty( $report_json['viewports']['mobile']['hasHorizontalOverflow'] ),
						),
						'tablet'  => array(
							'issues'       => isset( $report_json['viewports']['tablet']['issues'] ) ? count( $report_json['viewports']['tablet']['issues'] ) : 0,
							'scrollWidth'  => isset( $report_json['viewports']['tablet']['scrollWidth'] ) ? $report_json['viewports']['tablet']['scrollWidth'] : 0,
							'hasOverflow'  => ! empty( $report_json['viewports']['tablet']['hasHorizontalOverflow'] ),
						),
						'desktop' => array(
							'issues'       => isset( $report_json['viewports']['desktop']['issues'] ) ? count( $report_json['viewports']['desktop']['issues'] ) : 0,
							'scrollWidth'  => isset( $report_json['viewports']['desktop']['scrollWidth'] ) ? $report_json['viewports']['desktop']['scrollWidth'] : 0,
							'hasOverflow'  => ! empty( $report_json['viewports']['desktop']['hasHorizontalOverflow'] ),
						),
					),
					'output'    => $output,
				) );
			}
		}

		wp_send_json_success( array(
			'mode'    => 'audit',
			'page_id' => $page_id,
			'output'  => $output,
		) );
	}

	/**
	 * AJAX Handler: Run in-browser simulation for a page.
	 */
	public function handle_ajax_simulate() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user capability.' ), 403 );
		}

		check_ajax_referer( 'era_admin_nonce', 'nonce' );

		$page_id = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		if ( ! $page_id ) {
			wp_send_json_error( array( 'message' => 'Invalid page ID.' ), 400 );
		}

		$paths = $this->get_agent_paths( $page_id );
		if ( ! file_exists( $paths['cli_path'] ) ) {
			wp_send_json_error( array( 'message' => 'Agent CLI not built.' ), 500 );
		}

		$cmd = sprintf(
			'export PATH=%s:"$PATH:/usr/local/bin:/usr/bin:/bin" && cd %s && %s %s simulate -p %d -c %s --json 2>&1',
			escapeshellarg( $paths['node_dir'] ),
			escapeshellarg( $paths['agent_dir'] ),
			escapeshellarg( $paths['node_bin'] ),
			escapeshellarg( $paths['cli_path'] ),
			$page_id,
			escapeshellarg( $paths['css_path'] )
		);

		$output = shell_exec( $cmd );

		$first_brace = strpos( $output, '{' );
		$last_brace  = strrpos( $output, '}' );

		if ( $first_brace !== false && $last_brace !== false ) {
			$json_slice = substr( $output, $first_brace, $last_brace - $first_brace + 1 );
			$parsed = json_decode( $json_slice, true );
			if ( $parsed && isset( $parsed['viewports'] ) ) {
				wp_send_json_success( array(
					'mode'              => 'simulate',
					'page_id'           => $page_id,
					'verdict'           => isset( $parsed['verdict'] ) ? $parsed['verdict'] : 'SIMULATED',
					'viewports'         => $parsed['viewports'],
					'validationDetails' => isset( $parsed['validationDetails'] ) ? $parsed['validationDetails'] : null,
					'output'            => $output,
				) );
			}
		}

		wp_send_json_success( array(
			'mode'    => 'simulate',
			'page_id' => $page_id,
			'output'  => $output,
		) );
	}

	/**
	 * AJAX Handler: Apply Responsive Fix with Safety Backup & Re-audit.
	 */
	public function handle_ajax_apply_fix() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user capability.' ), 403 );
		}

		check_ajax_referer( 'era_admin_nonce', 'nonce' );

		$page_id = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		if ( ! $page_id ) {
			wp_send_json_error( array( 'message' => 'Invalid page ID.' ), 400 );
		}

		$paths = $this->get_agent_paths( $page_id );
		if ( ! file_exists( $paths['css_path'] ) ) {
			wp_send_json_error( array( 'message' => 'Responsive CSS fix not found at ' . $paths['css_path'] ), 500 );
		}

		$css_content = file_get_contents( $paths['css_path'] );
		$current_raw = get_post_meta( $page_id, '_elementor_data', true );
		if ( empty( $current_raw ) ) {
			$current_raw = '[]';
		}

		// 1. Create Timestamped Backup with Human-Readable Change Title
		$timestamp  = time();
		$backup_key = '_era_backup_' . $timestamp;
		$date_gmt   = gmdate( 'Y-m-d H:i:s', $timestamp );

		update_post_meta( $page_id, $backup_key, wp_slash( $current_raw ) );

		$backups_list = get_post_meta( $page_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}
		$backups_list[] = array(
			'key'           => $backup_key,
			'timestamp'     => $timestamp,
			'date_gmt'      => $date_gmt,
			'title'         => __( 'Auto-applied Universal Responsive Layout Fix', 'era-bridge' ),
			'section_title' => __( 'Full Page', 'era-bridge' ),
			'action_type'   => 'autofix',
			'details'       => __( 'Applied universal responsive candidate CSS with fluid containment & multi-viewport rules.', 'era-bridge' ),
		);
		update_post_meta( $page_id, '_era_backups_list', $backups_list );

		// File-based backup
		$upload_dir = wp_upload_dir();
		$backup_dir = $upload_dir['basedir'] . '/era-backups/page-' . $page_id;
		wp_mkdir_p( $backup_dir );
		file_put_contents( $backup_dir . '/' . $backup_key . '.json', $current_raw );

		// 2. Inject Responsive CSS into Elementor Structure
		$data = json_decode( $current_raw, true );
		if ( ! is_array( $data ) ) {
			$data = array();
		}

		// Remove any existing era_responsive_css_section
		$filtered_data = array();
		foreach ( $data as $section ) {
			if ( isset( $section['id'] ) && $section['id'] === 'era_responsive_css_section' ) {
				continue;
			}
			$filtered_data[] = $section;
		}

		// Prepend clean responsive CSS section
		$responsive_section = array(
			'id'       => 'era_responsive_css_section',
			'elType'   => 'section',
			'settings' => array( 'layout' => 'full_width' ),
			'elements' => array(
				array(
					'id'       => 'era_responsive_css_col',
					'elType'   => 'column',
					'elements' => array(
						array(
							'id'         => 'era_responsive_css_widget',
							'elType'     => 'widget',
							'widgetType' => 'html',
							'settings'   => array(
								'html' => "<style id=\"era-applied-responsive-fix\">\n" . $css_content . "\n</style>",
							),
						),
					),
				),
			),
		);

		array_unshift( $filtered_data, $responsive_section );

		// Save updated Elementor data
		update_post_meta( $page_id, '_elementor_data', wp_slash( json_encode( $filtered_data ) ) );
		delete_post_meta( $page_id, '_elementor_css' );

		// Clear Elementor CSS cache
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}

		// 3. Immediately Re-Audit the page to confirm 0 issues
		$cmd = sprintf(
			'export PATH=%s:"$PATH:/usr/local/bin:/usr/bin:/bin" && cd %s && %s %s audit -p %d 2>&1',
			escapeshellarg( $paths['node_dir'] ),
			escapeshellarg( $paths['agent_dir'] ),
			escapeshellarg( $paths['node_bin'] ),
			escapeshellarg( $paths['cli_path'] ),
			$page_id
		);

		$output = shell_exec( $cmd );

		$report_file = $paths['agent_dir'] . '/output/' . $page_id . '/report.json';
		$viewports = null;
		$summary = null;

		if ( file_exists( $report_file ) ) {
			$report_raw = file_get_contents( $report_file );
			$report_json = json_decode( $report_raw, true );
			if ( $report_json ) {
				$summary = isset( $report_json['summary'] ) ? $report_json['summary'] : null;
				$viewports = array(
					'mobile'  => array(
						'issues'       => isset( $report_json['viewports']['mobile']['issues'] ) ? count( $report_json['viewports']['mobile']['issues'] ) : 0,
						'scrollWidth'  => isset( $report_json['viewports']['mobile']['scrollWidth'] ) ? $report_json['viewports']['mobile']['scrollWidth'] : 0,
						'hasOverflow'  => ! empty( $report_json['viewports']['mobile']['hasHorizontalOverflow'] ),
					),
					'tablet'  => array(
						'issues'       => isset( $report_json['viewports']['tablet']['issues'] ) ? count( $report_json['viewports']['tablet']['issues'] ) : 0,
						'scrollWidth'  => isset( $report_json['viewports']['tablet']['scrollWidth'] ) ? $report_json['viewports']['tablet']['scrollWidth'] : 0,
						'hasOverflow'  => ! empty( $report_json['viewports']['tablet']['hasHorizontalOverflow'] ),
					),
					'desktop' => array(
						'issues'       => isset( $report_json['viewports']['desktop']['issues'] ) ? count( $report_json['viewports']['desktop']['issues'] ) : 0,
						'scrollWidth'  => isset( $report_json['viewports']['desktop']['scrollWidth'] ) ? $report_json['viewports']['desktop']['scrollWidth'] : 0,
						'hasOverflow'  => ! empty( $report_json['viewports']['desktop']['hasHorizontalOverflow'] ),
					),
				);
			}
		}

		wp_send_json_success( array(
			'mode'       => 'apply',
			'page_id'    => $page_id,
			'backup_key' => $backup_key,
			'date_gmt'   => $date_gmt,
			'summary'    => $summary,
			'viewports'  => $viewports,
			'output'     => $output,
		) );
	}

	public function handle_admin_restore() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			if ( wp_doing_ajax() ) {
				wp_send_json_error( array( 'message' => __( 'Unauthorized access.', 'era-bridge' ) ), 403 );
			}
			wp_die( __( 'Unauthorized access.', 'era-bridge' ) );
		}

		$is_ajax = wp_doing_ajax() || ! empty( $_POST['is_ajax'] );
		if ( $is_ajax ) {
			check_ajax_referer( 'era_restore_action', 'era_nonce' );
		} else {
			check_admin_referer( 'era_restore_action', 'era_nonce' );
		}

		$post_id = ! empty( $_POST['post_id'] ) ? absint( $_POST['post_id'] ) : ( ! empty( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0 );
		if ( ! $post_id ) {
			$post_id = ! empty( $_REQUEST['post_id'] ) ? absint( $_REQUEST['post_id'] ) : ( ! empty( $_REQUEST['page_id'] ) ? absint( $_REQUEST['page_id'] ) : 0 );
		}
		$backup_key = ! empty( $_POST['backup_key'] ) ? sanitize_text_field( $_POST['backup_key'] ) : ( ! empty( $_REQUEST['backup_key'] ) ? sanitize_text_field( $_REQUEST['backup_key'] ) : '' );

		if ( ! $post_id || empty( $backup_key ) ) {
			if ( $is_ajax ) {
				wp_send_json_error( array( 'message' => __( 'Invalid page ID or backup key.', 'era-bridge' ) ), 400 );
			}
			wp_redirect( admin_url( 'admin.php?page=era-backups&status=error' ) );
			exit;
		}

		$backup_raw = get_post_meta( $post_id, $backup_key, true );
		if ( empty( $backup_raw ) ) {
			$upload_dir = wp_upload_dir();
			$backup_file = $upload_dir['basedir'] . '/era-backups/page-' . $post_id . '/' . $backup_key . '.json';
			if ( file_exists( $backup_file ) ) {
				$backup_raw = file_get_contents( $backup_file );
			}
		}

		if ( ! empty( $backup_raw ) ) {
			// Find title of backup being restored
			$b_list = get_post_meta( $post_id, '_era_backups_list', true );
			if ( ! is_array( $b_list ) ) $b_list = array();
			$target_title = $backup_key;
			foreach ( $b_list as $b_item ) {
				if ( isset( $b_item['key'] ) && $b_item['key'] === $backup_key ) {
					$target_title = self::get_backup_title( $b_item );
					break;
				}
			}

			// Save current state as safety snapshot before restoring
			$current_raw = get_post_meta( $post_id, '_elementor_data', true );
			if ( ! empty( $current_raw ) ) {
				$pre_ts  = time();
				$pre_key = '_era_backup_' . $pre_ts . '_pre_restore';
				update_post_meta( $post_id, $pre_key, wp_slash( $current_raw ) );
				$b_list[] = array(
					'key'           => $pre_key,
					'timestamp'     => $pre_ts,
					'date_gmt'      => gmdate( 'Y-m-d H:i:s', $pre_ts ),
					'title'         => sprintf( __( 'Safety Snapshot (before restoring %s)', 'era-bridge' ), esc_html( $target_title ) ),
					'section_title' => __( 'Full Page', 'era-bridge' ),
					'action_type'   => 'restore',
					'details'       => __( 'Automatic safety snapshot captured prior to restoring an earlier version.', 'era-bridge' ),
				);
				update_post_meta( $post_id, '_era_backups_list', $b_list );
			}

			update_post_meta( $post_id, '_elementor_data', wp_slash( $backup_raw ) );
			delete_post_meta( $post_id, '_elementor_css' );
			if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
				\Elementor\Plugin::$instance->files_manager->clear_cache();
			}

			if ( $is_ajax ) {
				wp_send_json_success( array(
					'message'     => sprintf( __( 'Successfully restored version: "%s"', 'era-bridge' ), $target_title ),
					'page_id'     => $post_id,
					'backup_key'  => $backup_key,
					'title'       => $target_title,
					'restored_at' => gmdate( 'Y-m-d H:i:s' ),
					'page_url'    => get_permalink( $post_id ),
				) );
			}

			wp_redirect( admin_url( 'admin.php?page=era-backups&status=restored&page_id=' . $post_id ) );
			exit;
		}

		if ( $is_ajax ) {
			wp_send_json_error( array( 'message' => __( 'Backup snapshot could not be found.', 'era-bridge' ) ), 404 );
		}
		wp_redirect( admin_url( 'admin.php?page=era-backups&status=not_found' ) );
		exit;
	}

	/**
	 * Main Dashboard View.
	 */
	public function render_admin_page() {
		$nonce = wp_create_nonce( 'era_admin_nonce' );
		$node_bin = $this->get_node_bin();
		$node_ver = trim( (string) shell_exec( escapeshellarg( $node_bin ) . ' -v 2>/dev/null' ) );

		$pages_query = new WP_Query( array(
			'post_type'      => array( 'page', 'elementor_library' ),
			'post_status'    => array( 'publish', 'draft' ),
			'posts_per_page' => 50,
			'orderby'        => 'ID',
			'order'          => 'DESC',
		) );
		$pages = $pages_query->posts;

		?>
		<div class="wrap era-wrap">
			<style>
				.era-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
				.era-header h1 { margin: 0; font-size: 24px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
				.era-status-bar { display: flex; gap: 15px; margin-bottom: 25px; flex-wrap: wrap; }
				.era-card-stat { background: #fff; border: 1px solid #c3c4c7; border-radius: 8px; padding: 14px 20px; min-width: 200px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
				.era-card-stat .title { font-size: 12px; text-transform: uppercase; color: #646970; font-weight: 600; margin-bottom: 4px; }
				.era-card-stat .val { font-size: 18px; font-weight: 700; color: #1d2327; display: flex; align-items: center; gap: 6px; }
				.era-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
				.era-badge-success { background: #d1fae5; color: #065f46; }
				.era-badge-danger { background: #fee2e2; color: #991b1b; }
				.era-badge-info { background: #e0f2fe; color: #0369a1; }
				.era-table { background: #fff; border: 1px solid #c3c4c7; border-radius: 8px; overflow: hidden; margin-bottom: 30px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
				.era-table table { width: 100%; border-collapse: collapse; text-align: left; }
				.era-table th { background: #f6f7f7; padding: 12px 16px; font-size: 13px; font-weight: 600; color: #2c3338; border-bottom: 1px solid #c3c4c7; }
				.era-table td { padding: 12px 16px; border-bottom: 1px solid #f0f0f1; font-size: 13px; vertical-align: middle; }
				.era-table tr:last-child td { border-bottom: none; }
				.era-btn-action { margin-right: 6px !important; margin-bottom: 4px !important; }
				#era-results-panel { display: none; background: #fff; border: 2px solid #2271b1; border-radius: 8px; padding: 20px; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
				.era-results-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin: 15px 0; }
				.era-result-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 16px; }
				.era-result-box h4 { margin: 0 0 6px 0; font-size: 14px; color: #1e293b; }
				.era-log-drawer { background: #0f172a; color: #e2e8f0; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; margin-top: 15px; white-space: pre-wrap; }
				.era-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #cbd5e1; border-top-color: #2271b1; border-radius: 50%; animation: era-spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
				@keyframes era-spin { to { transform: rotate(360deg); } }
				.button-apply { background: #10b981 !important; border-color: #059669 !important; color: #fff !important; }
				.button-apply:hover { background: #059669 !important; }
			</style>

			<div class="era-header">
				<h1><span class="dashicons dashicons-smartphone" style="font-size:28px;"></span> ERA Responsive Layout Dashboard</h1>
			</div>

			<!-- Status Bar -->
			<div class="era-status-bar">
				<div class="era-card-stat">
					<div class="title">Engine Runtime</div>
					<div class="val">
						<?php if ( $node_ver ) : ?>
							<span class="era-badge era-badge-success">Active Node <?php echo esc_html( $node_ver ); ?></span>
						<?php else : ?>
							<span class="era-badge era-badge-danger">Node Unavailable</span>
						<?php endif; ?>
					</div>
				</div>
				<div class="era-card-stat">
					<div class="title">Safety Guard</div>
					<div class="val">
						<span class="era-badge era-badge-info">Automated Backups & Revert Active</span>
					</div>
				</div>
				<div class="era-card-stat">
					<div class="title">Auditable Pages</div>
					<div class="val"><?php echo count( $pages ); ?> Pages Found</div>
				</div>
			</div>

			<!-- Interactive Results Panel -->
			<div id="era-results-panel">
				<div style="display:flex; justify-content:space-between; align-items:center;">
					<h3 id="era-results-title" style="margin:0; font-size:16px;">Scan Results</h3>
					<button type="button" class="button" onclick="document.getElementById('era-results-panel').style.display='none';">Close</button>
				</div>
				<div id="era-results-body" style="margin-top:12px;"></div>
				<div id="era-results-log" class="era-log-drawer" style="display:none;"></div>
			</div>

			<!-- Pages Table -->
			<div class="era-table">
				<table>
					<thead>
						<tr>
							<th style="width: 70px;">ID</th>
							<th>Page Title</th>
							<th style="width: 140px;">Type / Status</th>
							<th style="width: 400px;">Responsive Actions</th>
						</tr>
					</thead>
					<tbody>
						<?php if ( empty( $pages ) ) : ?>
							<tr><td colspan="4" style="text-align:center; padding:30px;">No pages found.</td></tr>
						<?php else : ?>
							<?php foreach ( $pages as $p ) :
								$is_elementor = get_post_meta( $p->ID, '_elementor_edit_mode', true ) === 'builder';
								$permalink = get_permalink( $p->ID );
							?>
								<tr>
									<td><strong>#<?php echo esc_html( $p->ID ); ?></strong></td>
									<td>
										<strong><?php echo esc_html( $p->post_title ? $p->post_title : '(No title)' ); ?></strong>
										<?php if ( $is_elementor ) : ?>
											<span class="era-badge era-badge-info" style="margin-left: 6px;">Elementor</span>
										<?php endif; ?>
										<br/>
										<a href="<?php echo esc_url( $permalink ); ?>" target="_blank" style="font-size:11px; color:#646970; text-decoration:none;">
											<?php echo esc_html( $permalink ); ?> &nearr;
										</a>
									</td>
									<td>
										<code><?php echo esc_html( $p->post_type ); ?></code><br/>
										<span style="font-size:11px; color:#646970;"><?php echo esc_html( $p->post_status ); ?></span>
									</td>
									<td>
										<button type="button" class="button button-primary era-btn-action" onclick="runEraAction(<?php echo esc_attr( $p->ID ); ?>, 'audit', '<?php echo esc_js( $p->post_title ); ?>');">
											<span class="dashicons dashicons-search" style="font-size:15px; vertical-align:middle;"></span> Audit
										</button>
										<button type="button" class="button button-secondary era-btn-action" onclick="runEraAction(<?php echo esc_attr( $p->ID ); ?>, 'simulate', '<?php echo esc_js( $p->post_title ); ?>');">
											<span class="dashicons dashicons-controls-play" style="font-size:15px; vertical-align:middle;"></span> Simulate
										</button>
										<button type="button" class="button button-apply era-btn-action" onclick="runEraAction(<?php echo esc_attr( $p->ID ); ?>, 'apply', '<?php echo esc_js( $p->post_title ); ?>');">
											<span class="dashicons dashicons-yes-alt" style="font-size:15px; vertical-align:middle;"></span> Apply Fix
										</button>
										<a href="<?php echo esc_url( $permalink ); ?>" target="_blank" class="button era-btn-action" title="View page in new tab">
											View
										</a>
									</td>
								</tr>
							<?php endforeach; ?>
						<?php endif; ?>
					</tbody>
				</table>
			</div>
		</div>

		<script>
			function runEraAction(pageId, action, pageTitle) {
				var panel = document.getElementById('era-results-panel');
				var titleEl = document.getElementById('era-results-title');
				var bodyEl = document.getElementById('era-results-body');
				var logEl = document.getElementById('era-results-log');

				panel.style.display = 'block';
				logEl.style.display = 'none';

				var label = 'Auditing: ';
				if (action === 'simulate') label = 'Simulating Fix: ';
				if (action === 'apply') label = 'Applying Responsive Fix: ';

				titleEl.innerHTML = label + '<strong>#' + pageId + ' — ' + pageTitle + '</strong>';
				bodyEl.innerHTML = '<div style="padding:20px; text-align:center;"><span class="era-spinner"></span> ' + (action === 'apply' ? 'Creating safety backup, updating Elementor data, clearing cache & running verification audit...' : 'Scanning viewports (Mobile 375px, Tablet 768px, Desktop 1280px) in headless browser...') + ' Please wait 5-10s.</div>';

				var actionEndpoint = 'era_run_audit';
				if (action === 'simulate') actionEndpoint = 'era_run_simulate';
				if (action === 'apply') actionEndpoint = 'era_apply_fix';

				jQuery.ajax({
					url: ajaxurl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: actionEndpoint,
						page_id: pageId,
						nonce: '<?php echo esc_js( $nonce ); ?>'
					},
					success: function(res) {
						if (!res.success) {
							bodyEl.innerHTML = '<div class="notice notice-error"><p>Error: ' + (res.data ? res.data.message : 'Action failed.') + '</p></div>';
							return;
						}

						var data = res.data;
						if (data.mode === 'audit' && data.viewports) {
							var m = data.viewports.mobile;
							var t = data.viewports.tablet;
							var d = data.viewports.desktop;

							var html = '<div class="era-results-grid">';
							html += '<div class="era-result-box"><h4>📱 Mobile (375px)</h4>';
							html += '<p><strong>Issues:</strong> ' + m.issues + '</p>';
							html += '<p><strong>Width:</strong> ' + m.scrollWidth + 'px ' + (m.hasOverflow ? '<span class="era-badge era-badge-danger">Overflow</span>' : '<span class="era-badge era-badge-success">OK</span>') + '</p></div>';

							html += '<div class="era-result-box"><h4>💻 Tablet (768px)</h4>';
							html += '<p><strong>Issues:</strong> ' + t.issues + '</p>';
							html += '<p><strong>Width:</strong> ' + t.scrollWidth + 'px ' + (t.hasOverflow ? '<span class="era-badge era-badge-danger">Overflow</span>' : '<span class="era-badge era-badge-success">OK</span>') + '</p></div>';

							html += '<div class="era-result-box"><h4>🖥️ Desktop (1280px)</h4>';
							html += '<p><strong>Issues:</strong> ' + d.issues + '</p>';
							html += '<p><strong>Width:</strong> ' + d.scrollWidth + 'px ' + (d.hasOverflow ? '<span class="era-badge era-badge-danger">Overflow</span>' : '<span class="era-badge era-badge-success">OK</span>') + '</p></div>';
							html += '</div>';

							if (data.summary) {
								html += '<p style="margin: 10px 0;"><strong>Total Issues Detected:</strong> ' + data.summary.totalIssues + ' (P0 Critical Overflows: ' + data.summary.bySeverity.P0 + ')</p>';
							}

							bodyEl.innerHTML = html;
						} else if (data.mode === 'simulate' && data.viewports) {
							var vm = data.viewports.mobile;
							var vt = data.viewports.tablet;
							var vd = data.viewports.desktop;

							var html = '<div class="notice notice-success inline" style="margin:0 0 15px 0;"><p><strong>Simulation Completed!</strong> All horizontal overflows evaluated in sandbox without modifying the database.</p></div>';
							html += '<div class="era-results-grid">';
							
							html += '<div class="era-result-box"><h4>📱 Mobile (375px)</h4>';
							html += '<p><strong>ScrollWidth:</strong> ' + vm.baseline.scrollWidth + 'px &rarr; <strong>' + vm.simulated.scrollWidth + 'px</strong></p>';
							html += '<p><strong>P0 Overflows:</strong> ' + vm.baseline.P0 + ' &rarr; <span class="era-badge era-badge-success">' + vm.simulated.P0 + ' Issues</span></p></div>';

							html += '<div class="era-result-box"><h4>💻 Tablet (768px)</h4>';
							html += '<p><strong>ScrollWidth:</strong> ' + vt.baseline.scrollWidth + 'px &rarr; <strong>' + vt.simulated.scrollWidth + 'px</strong></p>';
							html += '<p><strong>P0 Overflows:</strong> ' + vt.baseline.P0 + ' &rarr; <span class="era-badge era-badge-success">' + vt.simulated.P0 + ' Issues</span></p></div>';

							html += '<div class="era-result-box"><h4>🖥️ Desktop (1280px)</h4>';
							html += '<p><strong>ScrollWidth:</strong> ' + vd.baseline.scrollWidth + 'px &rarr; <strong>' + vd.simulated.scrollWidth + 'px</strong></p>';
							html += '<p><strong>P0 Overflows:</strong> ' + vd.baseline.P0 + ' &rarr; <span class="era-badge era-badge-success">' + vd.simulated.P0 + ' Issues</span></p></div>';
							html += '</div>';

							bodyEl.innerHTML = html;
						} else if (data.mode === 'apply') {
							var html = '<div class="notice notice-success inline" style="margin:0 0 15px 0;"><p><strong>✅ Responsive Fix Applied Successfully!</strong> Automatic backup created: <code>' + data.backup_key + '</code></p></div>';
							if (data.viewports) {
								var am = data.viewports.mobile;
								var at = data.viewports.tablet;
								var ad = data.viewports.desktop;

								html += '<div class="era-results-grid">';
								html += '<div class="era-result-box"><h4>📱 Mobile (375px)</h4>';
								html += '<p><strong>Width:</strong> ' + am.scrollWidth + 'px ' + (am.hasOverflow ? '<span class="era-badge era-badge-danger">Overflow</span>' : '<span class="era-badge era-badge-success">Fixed (0 Overflow)</span>') + '</p>';
								html += '<p><strong>Issues:</strong> ' + am.issues + '</p></div>';

								html += '<div class="era-result-box"><h4>💻 Tablet (768px)</h4>';
								html += '<p><strong>Width:</strong> ' + at.scrollWidth + 'px ' + (at.hasOverflow ? '<span class="era-badge era-badge-danger">Overflow</span>' : '<span class="era-badge era-badge-success">Fixed (0 Overflow)</span>') + '</p>';
								html += '<p><strong>Issues:</strong> ' + at.issues + '</p></div>';

								html += '<div class="era-result-box"><h4>🖥️ Desktop (1280px)</h4>';
								html += '<p><strong>Width:</strong> ' + ad.scrollWidth + 'px ' + (ad.hasOverflow ? '<span class="era-badge era-badge-danger">Overflow</span>' : '<span class="era-badge era-badge-success">Fixed (0 Overflow)</span>') + '</p>';
								html += '<p><strong>Issues:</strong> ' + ad.issues + '</p></div>';
								html += '</div>';
							}
							html += '<p style="margin-top:15px;"><a href="' + ajaxurl.replace('admin-ajax.php', 'admin.php?page=era-backups') + '" class="button button-secondary">View Backup & Restore Options</a> <a href="<?php echo esc_url( home_url( '/' ) ); ?>" target="_blank" class="button button-primary">Open Live Site &nearr;</a></p>';
							bodyEl.innerHTML = html;
						} else {
							bodyEl.innerHTML = '<p>Scan completed. Output received.</p>';
						}

						if (data.output) {
							logEl.style.display = 'block';
							logEl.textContent = data.output;
						}
					},
					error: function(xhr, status, err) {
						bodyEl.innerHTML = '<div class="notice notice-error"><p>Server communication error: ' + err + '</p></div>';
					}
				});
			}
		</script>
		<?php
	}

	/**
	 * Helper: Format human-readable title for a backup entry.
	 */
	public static function get_backup_title( $backup, $index = 1 ) {
		if ( ! empty( $backup['title'] ) ) {
			return $backup['title'];
		}
		if ( ! empty( $backup['key'] ) && strpos( $backup['key'], 'pre_restore' ) !== false ) {
			return __( 'Pre-Restore Safety Snapshot', 'era-bridge' );
		}
		if ( ! empty( $backup['section_title'] ) && $backup['section_title'] !== 'Full Page' ) {
			return sprintf( __( 'Changes to %s', 'era-bridge' ), $backup['section_title'] );
		}
		$date = ! empty( $backup['date_gmt'] ) ? $backup['date_gmt'] : ( ! empty( $backup['timestamp'] ) ? gmdate( 'M j, Y H:i:s', $backup['timestamp'] ) : '' );
		if ( $date ) {
			return sprintf( __( 'Version from %s GMT', 'era-bridge' ), $date );
		}
		return sprintf( __( 'Page Version #%d', 'era-bridge' ), $index );
	}

	/**
	 * Backups & Restore Submenu View.
	 * Displays the demo page on the left and a right-side dropdown of changes to restore.
	 */
	public function render_backups_page() {
		$posts = get_posts( array(
			'post_type'      => array( 'page', 'post' ),
			'post_status'    => 'any',
			'posts_per_page' => 50,
			'meta_query'     => array(
				array(
					'key'     => '_era_backups_list',
					'compare' => 'EXISTS',
				),
			),
		) );

		// Compile page data and backups list for JavaScript
		$pages_data = array();
		$default_page_id = 0;

		foreach ( $posts as $p ) {
			$b_list = get_post_meta( $p->ID, '_era_backups_list', true );
			if ( ! is_array( $b_list ) || empty( $b_list ) ) {
				continue;
			}
			$rev_backups = array_reverse( $b_list );
			$formatted_backups = array();
			$total = count( $rev_backups );

			foreach ( $rev_backups as $idx => $b ) {
				$title   = self::get_backup_title( $b, $idx + 1 );
				$type    = ! empty( $b['action_type'] ) ? $b['action_type'] : 'autofix';
				$section = ! empty( $b['section_title'] ) ? $b['section_title'] : '';
				$date    = ! empty( $b['date_gmt'] ) ? $b['date_gmt'] : ( ! empty( $b['timestamp'] ) ? gmdate( 'Y-m-d H:i:s', $b['timestamp'] ) : '' );

				$formatted_backups[] = array(
					'key'           => $b['key'],
					'title'         => $title,
					'type'          => $type,
					'section_title' => $section,
					'date_gmt'      => $date,
					'display_label' => ( $idx === 0 ? '⚡ Latest: ' : ( 'Option ' . ( $idx + 1 ) . ': ' ) ) . $title . ( $date ? ' (' . $date . ')' : '' ),
				);
			}

			$permalink = get_permalink( $p->ID );
			$pages_data[ $p->ID ] = array(
				'id'        => $p->ID,
				'title'     => get_the_title( $p->ID ),
				'permalink' => $permalink,
				'backups'   => $formatted_backups,
			);

			if ( ! $default_page_id || $p->ID == 521 ) {
				$default_page_id = $p->ID;
			}
		}

		$nonce = wp_create_nonce( 'era_restore_action' );
		?>
		<div class="wrap" style="max-width:1400px;">
			<h1 style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:24px;font-weight:700;">
				<span class="dashicons dashicons-backup" style="font-size:28px;width:28px;height:28px;color:#0284c7;"></span>
				<?php esc_html_e( 'ERA Page Version History & Restore', 'era-bridge' ); ?>
			</h1>
			<p style="color:#64748b;font-size:14px;margin-top:0;margin-bottom:18px;">
				<?php esc_html_e( 'View your page on the left and select any change from the right-side dropdown to restore that version instantly.', 'era-bridge' ); ?>
			</p>

			<?php if ( isset( $_GET['status'] ) && $_GET['status'] === 'restored' ) : ?>
				<div class="notice notice-success is-dismissible" style="border-left-color:#10b981;margin-bottom:16px;">
					<p style="font-weight:600;">✅ <?php esc_html_e( 'Version successfully restored and Elementor CSS cache cleared!', 'era-bridge' ); ?></p>
				</div>
			<?php endif; ?>

			<?php if ( empty( $pages_data ) ) : ?>
				<div class="card" style="padding:28px;border-radius:10px;">
					<p style="font-size:14px;color:#64748b;margin:0;">
						<?php esc_html_e( 'No page backups found yet. Whenever changes are made or responsive fixes are applied, version snapshots will appear here.', 'era-bridge' ); ?>
					</p>
				</div>
			<?php else : ?>

				<!-- Top Interactive Split Viewer: Display Page on Left + Dropdown of Changes on Right -->
				<div class="era-split-preview-card" style="max-width:100% !important;width:100%;box-sizing:border-box;background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:0;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.06);margin-bottom:28px;">
					<!-- Header Toolbar -->
					<div style="background:#0f172a;color:#fff;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
						<div style="display:flex;align-items:center;gap:12px;">
							<span style="font-weight:700;font-size:15px;display:flex;align-items:center;gap:6px;">
								<span>🖥️</span> <?php esc_html_e( 'Page Preview & Version Restorer', 'era-bridge' ); ?>
							</span>
							<?php if ( count( $pages_data ) > 1 ) : ?>
								<select id="era-page-switcher" onchange="eraChangeActivePage(this.value);" style="background:#1e293b;color:#fff;border:1px solid #334155;border-radius:6px;height:32px;font-size:12px;padding:0 8px;">
									<?php foreach ( $pages_data as $pid => $pinfo ) : ?>
										<option value="<?php echo esc_attr( $pid ); ?>" <?php selected( $pid, $default_page_id ); ?>>
											<?php echo esc_html( '#' . $pid . ' — ' . $pinfo['title'] . ' (' . count( $pinfo['backups'] ) . ' versions)' ); ?>
										</option>
									<?php endforeach; ?>
								</select>
							<?php else : ?>
								<span style="background:#1e293b;color:#38bdf8;font-size:12px;padding:3px 10px;border-radius:12px;font-weight:600;">
									<?php echo esc_html( '#' . $default_page_id . ' — ' . $pages_data[ $default_page_id ]['title'] ); ?>
								</span>
							<?php endif; ?>
						</div>

						<!-- Device viewport toggle buttons -->
						<div style="display:flex;align-items:center;gap:6px;">
							<button type="button" class="button button-small era-vp-btn active" onclick="eraSetPreviewViewport('100%', this);" style="background:#334155;color:#fff;border:none;">
								🖥️ Desktop
							</button>
							<button type="button" class="button button-small era-vp-btn" onclick="eraSetPreviewViewport('768px', this);" style="background:#1e293b;color:#94a3b8;border:none;">
								💻 Tablet
							</button>
							<button type="button" class="button button-small era-vp-btn" onclick="eraSetPreviewViewport('375px', this);" style="background:#1e293b;color:#94a3b8;border:none;">
								📱 Mobile
							</button>
							<a id="era-open-page-link" href="<?php echo esc_url( $pages_data[ $default_page_id ]['permalink'] ); ?>" target="_blank" class="button button-small" style="background:#1e293b;color:#38bdf8;border:none;margin-left:6px;" title="Open page in new browser tab">
								Open &nearr;
							</a>
							<button type="button" class="button button-small" onclick="eraReloadPreviewFrame();" style="background:#1e293b;color:#fff;border:none;" title="Reload preview iframe">
								🔄
							</button>
						</div>
					</div>

					<!-- Split Screen Layout: Left Page View + Right Dropdown Panel (Always Side-by-Side) -->
					<div style="display:flex;flex-direction:row;flex-wrap:nowrap;min-height:680px;background:#f8fafc;align-items:stretch;">
						<!-- LEFT: Display the Demo Page -->
						<div style="flex:1 1 auto;width:calc(100% - 360px);min-width:0;background:#e2e8f0;padding:16px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;">
							<div id="era-iframe-wrapper" style="width:100%;height:650px;background:#fff;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);overflow:hidden;transition:width 0.3s ease;">
								<iframe id="era-demo-iframe" src="<?php echo esc_url( $pages_data[ $default_page_id ]['permalink'] ); ?>" style="width:100%;height:100%;border:none;background:#fff;"></iframe>
							</div>
						</div>

						<!-- RIGHT: Dropdown of Changes Done & Instant Restore -->
						<div style="width:360px;min-width:360px;flex-shrink:0;background:#fff;border-left:1px solid #cbd5e1;padding:22px;display:flex;flex-direction:column;box-sizing:border-box;">
							<div style="margin-bottom:16px;">
								<h3 style="margin:0 0 6px 0;font-size:16px;color:#0f172a;display:flex;align-items:center;gap:6px;">
									<span>📋</span> <?php esc_html_e( 'Changes Done on This Page', 'era-bridge' ); ?>
								</h3>
								<p style="margin:0;font-size:13px;color:#64748b;line-height:1.4;">
									<?php esc_html_e( 'Select any change from the dropdown to restore that version:', 'era-bridge' ); ?>
								</p>
							</div>

							<!-- The Dropdown -->
							<div style="margin-bottom:16px;">
								<label for="era-right-dropdown" style="display:block;font-size:12px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
									<?php esc_html_e( 'Choose Version to Restore:', 'era-bridge' ); ?>
								</label>
								<select id="era-right-dropdown" onchange="eraOnRightDropdownChange(this);" style="width:100%;height:44px;font-size:13px;font-weight:600;border:2px solid #0284c7;border-radius:8px;padding:0 12px;background:#f0f9ff;color:#0369a1;cursor:pointer;">
									<!-- Populated via JavaScript -->
								</select>
							</div>

							<!-- Detailed Information Card of Selected Change -->
							<div id="era-change-info-card" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:18px;">
								<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
									<span id="era-info-badge" style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:12px;background:#e0f2fe;color:#0369a1;text-transform:uppercase;">Auto Fix</span>
									<span id="era-info-date" style="font-size:11px;color:#94a3b8;">-</span>
								</div>
								<div id="era-info-title" style="font-weight:700;font-size:14px;color:#0f172a;line-height:1.4;margin-bottom:6px;">
									Change Title
								</div>
								<div id="era-info-section" style="font-size:12px;color:#64748b;margin-bottom:6px;">
									Section: Full Page
								</div>
								<div style="font-size:11px;color:#94a3b8;font-family:monospace;background:#f1f5f9;padding:4px 8px;border-radius:4px;word-break:break-all;">
									Key: <span id="era-info-key">-</span>
								</div>
							</div>

							<!-- Restore Action Button -->
							<button type="button" id="era-btn-split-restore" class="button button-primary" onclick="eraExecuteRightRestore();" style="width:100%;height:46px;font-size:14px;font-weight:700;background:#0284c7;border-color:#0284c7;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;box-shadow:0 2px 4px rgba(2,132,199,0.25);">
								<span class="dashicons dashicons-backup" style="font-size:18px;margin-top:2px;"></span>
								<span id="era-btn-restore-label"><?php esc_html_e( 'Restore Selected Version', 'era-bridge' ); ?></span>
							</button>

							<!-- Feedback Alert -->
							<div id="era-split-status" style="display:none;margin-top:14px;padding:12px;border-radius:8px;font-size:13px;line-height:1.4;"></div>

							<!-- Total count & safety note -->
							<div style="margin-top:auto;padding-top:16px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;line-height:1.4;">
								🛡️ <em><?php esc_html_e( 'A safety snapshot of your current page will be saved automatically before restoring.', 'era-bridge' ); ?></em>
							</div>
						</div>
					</div>
				</div>

				<!-- All Pages Summary Table: One Clean Row Per Page with Right-Side Dropdown -->
				<h2 style="font-size:18px;font-weight:700;margin:28px 0 12px 0;display:flex;align-items:center;gap:8px;">
					<span>📑</span> <?php esc_html_e( 'Pages & Version Pickers', 'era-bridge' ); ?>
				</h2>

				<table class="wp-list-table widefat fixed striped" style="border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:30px;">
					<thead>
						<tr>
							<th style="width:35%;"><?php esc_html_e( 'Page', 'era-bridge' ); ?></th>
							<th style="width:65%;"><?php esc_html_e( 'Choose Change to Restore (Dropdown)', 'era-bridge' ); ?></th>
						</tr>
					</thead>
					<tbody>
						<?php foreach ( $pages_data as $pid => $pinfo ) :
							$backups_count = count( $pinfo['backups'] );
							$latest        = ! empty( $pinfo['backups'][0] ) ? $pinfo['backups'][0] : null;
						?>
							<tr class="era-table-page-row" data-page-id="<?php echo esc_attr( $pid ); ?>">
								<!-- Left: Page details -->
								<td style="vertical-align:top;padding:16px;">
									<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
										<span style="font-weight:700;color:#0284c7;font-size:14px;">#<?php echo esc_html( $pid ); ?></span>
										<strong style="font-size:15px;color:#0f172a;"><?php echo esc_html( $pinfo['title'] ); ?></strong>
									</div>
									<div style="margin-bottom:8px;">
										<a href="<?php echo esc_url( $pinfo['permalink'] ); ?>" target="_blank" style="font-size:12px;color:#64748b;text-decoration:none;">
											<?php echo esc_html( $pinfo['permalink'] ); ?> &nearr;
										</a>
									</div>
									<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
										<span style="background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:700;padding:2px 8px;border-radius:12px;">
											<?php echo esc_html( sprintf( _n( '%d change recorded', '%d changes recorded', $backups_count, 'era-bridge' ), $backups_count ) ); ?>
										</span>
										<button type="button" class="button button-small" onclick="eraChangeActivePage(<?php echo esc_attr( $pid ); ?>); window.scrollTo({top:0, behavior:'smooth'});" style="font-size:11px;">
											👁️ Preview Above
										</button>
									</div>
								</td>

								<!-- Right: Dropdown of changes and Restore button -->
								<td style="vertical-align:top;padding:16px;">
									<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
										<select class="era-table-dropdown" data-page-id="<?php echo esc_attr( $pid ); ?>" onchange="eraOnTableDropdownChange(this, <?php echo esc_attr( $pid ); ?>);" style="flex:1;min-width:320px;height:40px;font-size:13px;font-weight:500;border-radius:6px;border:1px solid #cbd5e1;padding:0 10px;">
											<?php foreach ( $pinfo['backups'] as $b ) : ?>
												<option value="<?php echo esc_attr( $b['key'] ); ?>" 
														data-title="<?php echo esc_attr( $b['title'] ); ?>" 
														data-type="<?php echo esc_attr( $b['type'] ); ?>" 
														data-section="<?php echo esc_attr( $b['section_title'] ); ?>" 
														data-date="<?php echo esc_attr( $b['date_gmt'] ); ?>">
													<?php echo esc_html( $b['display_label'] ); ?>
												</option>
											<?php endforeach; ?>
										</select>

										<button type="button" class="button button-primary" onclick="eraRestoreFromTable(<?php echo esc_attr( $pid ); ?>, this);" style="background:#0284c7;border-color:#0284c7;height:40px;padding:0 18px;font-weight:600;font-size:13px;border-radius:6px;">
											↺ <?php esc_html_e( 'Restore', 'era-bridge' ); ?>
										</button>
									</div>

									<!-- Live Pill showing details of currently selected change -->
									<div id="era-table-pill-<?php echo esc_attr( $pid ); ?>" style="margin-top:8px;font-size:12px;color:#475569;display:flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;padding:6px 12px;border-radius:6px;">
										<?php if ( $latest ) : ?>
											<span style="font-weight:700;color:#0f172a;"><?php echo esc_html( $latest['title'] ); ?></span>
											<?php if ( ! empty( $latest['section_title'] ) ) : ?>
												<span style="color:#64748b;">(<?php echo esc_html( $latest['section_title'] ); ?>)</span>
											<?php endif; ?>
											<span style="margin-left:auto;color:#94a3b8;font-size:11px;"><?php echo esc_html( $latest['date_gmt'] ); ?></span>
										<?php endif; ?>
									</div>
								</td>
							</tr>
						<?php endforeach; ?>
					</tbody>
				</table>

			<?php endif; ?>
		</div>

		<script>
			var eraPagesData = <?php echo wp_json_encode( $pages_data ); ?>;
			var eraCurrentPageId = <?php echo intval( $default_page_id ); ?>;
			var eraRestoreNonce = '<?php echo esc_js( $nonce ); ?>';
			var eraAjaxUrl = '<?php echo esc_js( admin_url( 'admin-ajax.php' ) ); ?>';

			function eraPopulateRightDropdown(pageId) {
				var page = eraPagesData[pageId];
				if (!page) return;

				var select = document.getElementById('era-right-dropdown');
				if (!select) return;

				select.innerHTML = '';
				var backups = page.backups || [];
				for (var i = 0; i < backups.length; i++) {
					var b = backups[i];
					var opt = document.createElement('option');
					opt.value = b.key;
					opt.textContent = b.display_label;
					opt.setAttribute('data-title', b.title);
					opt.setAttribute('data-type', b.type);
					opt.setAttribute('data-section', b.section_title);
					opt.setAttribute('data-date', b.date_gmt);
					opt.setAttribute('data-key', b.key);
					select.appendChild(opt);
				}

				if (backups.length > 0) {
					eraUpdateInfoCard(backups[0]);
				}
			}

			function eraUpdateInfoCard(backup) {
				if (!backup) return;

				var titleEl   = document.getElementById('era-info-title');
				var badgeEl   = document.getElementById('era-info-badge');
				var sectionEl = document.getElementById('era-info-section');
				var dateEl    = document.getElementById('era-info-date');
				var keyEl     = document.getElementById('era-info-key');

				if (titleEl)   titleEl.textContent   = backup.title || 'Version Snapshot';
				if (sectionEl) sectionEl.textContent = 'Section: ' + (backup.section_title || 'Full Page');
				if (dateEl)    dateEl.textContent    = backup.date_gmt || '-';
				if (keyEl)     keyEl.textContent     = backup.key;

				if (badgeEl) {
					var t = (backup.type || 'autofix').toLowerCase();
					if (t === 'style') {
						badgeEl.textContent = 'Style';
						badgeEl.style.background = '#ede9fe';
						badgeEl.style.color = '#6d28d9';
					} else if (t === 'content') {
						badgeEl.textContent = 'Content';
						badgeEl.style.background = '#dcfce7';
						badgeEl.style.color = '#15803d';
					} else if (t === 'restore') {
						badgeEl.textContent = 'Restore Point';
						badgeEl.style.background = '#fee2e2';
						badgeEl.style.color = '#b91c1c';
					} else {
						badgeEl.textContent = 'Auto Fix';
						badgeEl.style.background = '#e0f2fe';
						badgeEl.style.color = '#0369a1';
					}
				}
			}

			function eraOnRightDropdownChange(selectEl) {
				var opt = selectEl.options[selectEl.selectedIndex];
				if (!opt) return;

				var backup = {
					key: opt.value,
					title: opt.getAttribute('data-title'),
					type: opt.getAttribute('data-type'),
					section_title: opt.getAttribute('data-section'),
					date_gmt: opt.getAttribute('data-date')
				};
				eraUpdateInfoCard(backup);
			}

			function eraChangeActivePage(pageId) {
				pageId = parseInt(pageId, 10);
				if (!eraPagesData[pageId]) return;

				eraCurrentPageId = pageId;
				var page = eraPagesData[pageId];

				// Update iframe
				var iframe = document.getElementById('era-demo-iframe');
				if (iframe) {
					iframe.src = page.permalink;
				}

				// Update link
				var link = document.getElementById('era-open-page-link');
				if (link) {
					link.href = page.permalink;
				}

				// Update dropdown
				eraPopulateRightDropdown(pageId);
			}

			function eraSetPreviewViewport(width, btnEl) {
				var wrap = document.getElementById('era-iframe-wrapper');
				if (wrap) {
					wrap.style.width = width;
				}
				var btns = document.querySelectorAll('.era-vp-btn');
				btns.forEach(function(b) {
					b.style.background = '#1e293b';
					b.style.color = '#94a3b8';
					b.classList.remove('active');
				});
				btnEl.style.background = '#334155';
				btnEl.style.color = '#fff';
				btnEl.classList.add('active');
			}

			function eraReloadPreviewFrame() {
				var iframe = document.getElementById('era-demo-iframe');
				if (iframe) {
					iframe.src = iframe.src;
				}
			}

			function eraExecuteRightRestore() {
				var select = document.getElementById('era-right-dropdown');
				if (!select || !select.value) {
					alert('Please select a version to restore.');
					return;
				}
				var key = select.value;
				var opt = select.options[select.selectedIndex];
				var title = opt ? opt.getAttribute('data-title') : key;

				if (!confirm('Are you sure you want to restore this version:\n"' + title + '"?\n\nA safety snapshot of your current page will be saved automatically.')) {
					return;
				}

				var btn = document.getElementById('era-btn-split-restore');
				var label = document.getElementById('era-btn-restore-label');
				var status = document.getElementById('era-split-status');

				btn.disabled = true;
				if (label) label.textContent = 'Restoring version...';
				if (status) status.style.display = 'none';

				jQuery.ajax({
					url: eraAjaxUrl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: 'era_restore_backup',
						page_id: eraCurrentPageId,
						backup_key: key,
						era_nonce: eraRestoreNonce,
						is_ajax: 1
					},
					success: function(res) {
						btn.disabled = false;
						if (label) label.textContent = 'Restore Selected Version';

						if (!res.success) {
							if (status) {
								status.style.display = 'block';
								status.style.background = '#fef2f2';
								status.style.color = '#991b1b';
								status.style.border = '1px solid #fecaca';
								status.innerHTML = '❌ <strong>Restore Error:</strong> ' + (res.data ? res.data.message : 'Failed');
							}
							return;
						}

						if (status) {
							status.style.display = 'block';
							status.style.background = '#f0fdf4';
							status.style.color = '#166534';
							status.style.border = '1px solid #bbf7d0';
							status.innerHTML = '✅ <strong>Restored Successfully!</strong> Page restored to “' + title + '”. Reloading preview...';
						}

						// Reload live iframe to display restored version immediately
						setTimeout(function() {
							eraReloadPreviewFrame();
						}, 600);
					},
					error: function(xhr, st, err) {
						btn.disabled = false;
						if (label) label.textContent = 'Restore Selected Version';
						if (status) {
							status.style.display = 'block';
							status.style.background = '#fef2f2';
							status.style.color = '#991b1b';
							status.style.border = '1px solid #fecaca';
							status.innerHTML = '❌ Server communication error: ' + err;
						}
					}
				});
			}

			function eraOnTableDropdownChange(selectEl, pageId) {
				var opt = selectEl.options[selectEl.selectedIndex];
				var pill = document.getElementById('era-table-pill-' + pageId);
				if (pill && opt) {
					var title = opt.getAttribute('data-title') || opt.textContent;
					var section = opt.getAttribute('data-section');
					var date = opt.getAttribute('data-date');
					pill.innerHTML = '<span style="font-weight:700;color:#0f172a;">' + title + '</span>' +
						(section ? ' <span style="color:#64748b;">(' + section + ')</span>' : '') +
						'<span style="margin-left:auto;color:#94a3b8;font-size:11px;">' + (date || '') + '</span>';
				}
			}

			function eraRestoreFromTable(pageId, btnEl) {
				var select = document.querySelector('.era-table-dropdown[data-page-id="' + pageId + '"]');
				if (!select || !select.value) return;

				var key = select.value;
				var opt = select.options[select.selectedIndex];
				var title = opt ? opt.getAttribute('data-title') : key;

				if (!confirm('Restore this version for Page #' + pageId + ':\n"' + title + '"?\n\nA safety backup will be saved automatically.')) {
					return;
				}

				btnEl.disabled = true;
				btnEl.innerHTML = '↺ Restoring...';

				jQuery.ajax({
					url: eraAjaxUrl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: 'era_restore_backup',
						page_id: pageId,
						backup_key: key,
						era_nonce: eraRestoreNonce,
						is_ajax: 1
					},
					success: function(res) {
						btnEl.disabled = false;
						btnEl.innerHTML = '✅ Restored!';
						setTimeout(function() {
							btnEl.innerHTML = '↺ Restore';
						}, 2500);

						// If currently previewing this page, reload preview
						if (pageId === eraCurrentPageId) {
							eraReloadPreviewFrame();
						}
					},
					error: function(xhr, st, err) {
						btnEl.disabled = false;
						btnEl.innerHTML = '↺ Restore';
						alert('Restore failed: ' + err);
					}
				});
			}

			// Initialize on ready
			document.addEventListener('DOMContentLoaded', function() {
				if (eraCurrentPageId && eraPagesData[eraCurrentPageId]) {
					eraPopulateRightDropdown(eraCurrentPageId);
				}
			});
			if (document.readyState === 'interactive' || document.readyState === 'complete') {
				if (eraCurrentPageId && eraPagesData[eraCurrentPageId]) {
					eraPopulateRightDropdown(eraCurrentPageId);
				}
			}
		</script>
		<?php
	}
}
