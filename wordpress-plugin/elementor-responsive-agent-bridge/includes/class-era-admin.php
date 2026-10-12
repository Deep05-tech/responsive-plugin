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

		// 1. Create Timestamped Backup
		$timestamp  = time();
		$backup_key = '_era_backup_' . $timestamp;
		$date_gmt   = gmdate( 'Y-m-d H:i:s', $timestamp );

		update_post_meta( $page_id, $backup_key, wp_slash( $current_raw ) );

		$backups_list = get_post_meta( $page_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}
		$backups_list[] = array(
			'key'       => $backup_key,
			'timestamp' => $timestamp,
			'date_gmt'  => $date_gmt,
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
			wp_die( __( 'Unauthorized access.', 'era-bridge' ) );
		}

		check_admin_referer( 'era_restore_action', 'era_nonce' );

		$post_id = isset( $_POST['post_id'] ) ? absint( $_POST['post_id'] ) : 0;
		$backup_key = isset( $_POST['backup_key'] ) ? sanitize_text_field( $_POST['backup_key'] ) : '';

		if ( ! $post_id || empty( $backup_key ) ) {
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
			update_post_meta( $post_id, '_elementor_data', wp_slash( $backup_raw ) );
			delete_post_meta( $post_id, '_elementor_css' );
			if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
				\Elementor\Plugin::$instance->files_manager->clear_cache();
			}
			wp_redirect( admin_url( 'admin.php?page=era-backups&status=restored&page_id=' . $post_id ) );
			exit;
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
	 * Backups & Restore Submenu View.
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

		?>
		<div class="wrap">
			<h1><span class="dashicons dashicons-backup" style="font-size:26px;"></span> <?php esc_html_e( 'ERA Backups & Restores', 'era-bridge' ); ?></h1>
			<p><?php esc_html_e( 'Below are timestamped backups automatically created before responsive patches were applied.', 'era-bridge' ); ?></p>

			<?php if ( isset( $_GET['status'] ) && $_GET['status'] === 'restored' ) : ?>
				<div class="notice notice-success is-dismissible"><p><?php esc_html_e( 'Backup successfully restored and Elementor CSS cache cleared!', 'era-bridge' ); ?></p></div>
			<?php elseif ( isset( $_GET['status'] ) && $_GET['status'] === 'error' ) : ?>
				<div class="notice notice-error is-dismissible"><p><?php esc_html_e( 'Failed to restore backup.', 'era-bridge' ); ?></p></div>
			<?php endif; ?>

			<?php if ( empty( $posts ) ) : ?>
				<div class="card"><p><?php esc_html_e( 'No backups created yet. When you click "Apply Fix", backups will appear here automatically.', 'era-bridge' ); ?></p></div>
			<?php else : ?>
				<table class="wp-list-table widefat fixed striped" style="margin-top:15px;">
					<thead>
						<tr>
							<th><?php esc_html_e( 'Page ID', 'era-bridge' ); ?></th>
							<th><?php esc_html_e( 'Page Title', 'era-bridge' ); ?></th>
							<th><?php esc_html_e( 'Backup Key', 'era-bridge' ); ?></th>
							<th><?php esc_html_e( 'Backup Date (GMT)', 'era-bridge' ); ?></th>
							<th><?php esc_html_e( 'Action', 'era-bridge' ); ?></th>
						</tr>
					</thead>
					<tbody>
						<?php foreach ( $posts as $p ) :
							$backups = get_post_meta( $p->ID, '_era_backups_list', true );
							if ( ! is_array( $backups ) ) continue;
							foreach ( array_reverse( $backups ) as $b ) : ?>
								<tr>
									<td><strong>#<?php echo esc_html( $p->ID ); ?></strong></td>
									<td><?php echo esc_html( get_the_title( $p->ID ) ); ?></td>
									<td><code><?php echo esc_html( $b['key'] ); ?></code></td>
									<td><?php echo esc_html( $b['date_gmt'] ); ?></td>
									<td>
										<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
											<input type="hidden" name="action" value="era_restore_backup" />
											<input type="hidden" name="post_id" value="<?php echo esc_attr( $p->ID ); ?>" />
											<input type="hidden" name="backup_key" value="<?php echo esc_attr( $b['key'] ); ?>" />
											<?php wp_nonce_field( 'era_restore_action', 'era_nonce' ); ?>
											<button type="submit" class="button button-primary" onclick="return confirm('Restore this backup? This will overwrite the page _elementor_data.');">
												<?php esc_html_e( 'Restore Backup', 'era-bridge' ); ?>
											</button>
										</form>
									</td>
								</tr>
							<?php endforeach;
						endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
		<?php
	}
}
