<?php
/**
 * REST API controller for Elementor Responsive Agent Bridge.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ERA_REST_API {

	const NAMESPACE = 'era/v1';

	/**
	 * Allowed responsive key suffixes (Hard Rule 2).
	 */
	private $allowed_suffixes = array(
		'_mobile',
		'_tablet',
		'_mobile_extra',
		'_tablet_extra',
	);

	/**
	 * Hiding keys (Hard Rule 7).
	 */
	private $hide_keys = array(
		'hide_mobile',
		'hide_tablet',
		'hide_mobile_extra',
		'hide_tablet_extra',
	);

	/**
	 * Register REST routes.
	 */
	public function register_routes() {
		// GET /wp-json/era/v1/pages (Read-Only)
		register_rest_route(
			self::NAMESPACE,
			'/pages',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_pages' ),
				'permission_callback' => array( $this, 'check_permission' ),
			)
		);

		// GET /wp-json/era/v1/page/{id} (Read-Only)
		register_rest_route(
			self::NAMESPACE,
			'/page/(?P<id>\d+)',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_page' ),
				'permission_callback' => array( $this, 'check_permission' ),
				'args'                => array(
					'id' => array(
						'validate_callback' => function( $param ) {
							return is_numeric( $param ) && intval( $param ) > 0;
						},
						'sanitize_callback' => 'absint',
					),
				),
			)
		);

		// GET /wp-json/era/v1/page/{id}/backups (Read-Only)
		register_rest_route(
			self::NAMESPACE,
			'/page/(?P<id>\d+)/backups',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_backups' ),
				'permission_callback' => array( $this, 'check_permission' ),
				'args'                => array(
					'id' => array(
						'validate_callback' => function( $param ) {
							return is_numeric( $param ) && intval( $param ) > 0;
						},
						'sanitize_callback' => 'absint',
					),
				),
			)
		);

		// WRITE ROUTES: Strictly gated behind ERA_ENABLE_WRITES === true
		if ( defined( 'ERA_ENABLE_WRITES' ) && ERA_ENABLE_WRITES === true ) {
			// POST /wp-json/era/v1/page/{id}/patch
			register_rest_route(
				self::NAMESPACE,
				'/page/(?P<id>\d+)/patch',
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'patch_page' ),
					'permission_callback' => array( $this, 'check_permission' ),
					'args'                => array(
						'id' => array(
							'validate_callback' => function( $param ) {
								return is_numeric( $param ) && intval( $param ) > 0;
							},
							'sanitize_callback' => 'absint',
						),
					),
				)
			);

			// POST /wp-json/era/v1/page/{id}/restore
			register_rest_route(
				self::NAMESPACE,
				'/page/(?P<id>\d+)/restore',
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'restore_page' ),
					'permission_callback' => array( $this, 'check_permission' ),
					'args'                => array(
						'id' => array(
							'validate_callback' => function( $param ) {
								return is_numeric( $param ) && intval( $param ) > 0;
							},
							'sanitize_callback' => 'absint',
						),
					),
				)
			);
		}
	}

	/**
	 * Nonce-free permission callback checking edit_pages capability.
	 */
	public function check_permission( $request ) {
		if ( ! current_user_can( 'edit_pages' ) ) {
			return new WP_Error(
				'era_rest_forbidden',
				__( 'You do not have permission to access Elementor Responsive Agent Bridge.', 'era-bridge' ),
				array( 'status' => rest_authorization_required_code() )
			);
		}
		return true;
	}

	/**
	 * GET /pages
	 */
	public function get_pages( $request ) {
		$query_args = array(
			'post_type'      => array( 'page', 'post', 'elementor_library' ),
			'post_status'    => array( 'publish', 'draft', 'pending' ),
			'posts_per_page' => 200,
			'meta_query'     => array(
				array(
					'key'     => '_elementor_edit_mode',
					'value'   => 'builder',
					'compare' => '=',
				),
			),
		);

		$posts = get_posts( $query_args );
		$library_headers_footers = array();
		$library_other = array();
		$standard_pages = array();

		foreach ( $posts as $post ) {
			$template_type = '';
			if ( $post->post_type === 'elementor_library' ) {
				$template_type = get_post_meta( $post->ID, '_elementor_template_type', true );
				if ( empty( $template_type ) ) {
					$template_type = 'section';
				}
			}

			$item = array(
				'id'            => $post->ID,
				'title'         => get_the_title( $post->ID ),
				'post_type'     => $post->post_type,
				'template_type' => $template_type,
				'url'           => get_permalink( $post->ID ),
				'modified'      => $post->post_modified_gmt,
				'status'        => $post->post_status,
			);

			if ( in_array( strtolower( $template_type ), array( 'header', 'footer' ), true ) ) {
				$library_headers_footers[] = $item;
			} elseif ( $post->post_type === 'elementor_library' ) {
				$library_other[] = $item;
			} else {
				$standard_pages[] = $item;
			}
		}

		$results = array_merge( $library_headers_footers, $library_other, $standard_pages );

		return rest_ensure_response( $results );
	}

	/**
	 * GET /page/{id}
	 */
	public function get_page( $request ) {
		$post_id = $request->get_param( 'id' );
		$post = get_post( $post_id );

		if ( ! $post ) {
			return new WP_Error( 'era_post_not_found', __( 'Post not found.', 'era-bridge' ), array( 'status' => 404 ) );
		}

		$raw_data = get_post_meta( $post_id, '_elementor_data', true );
		$data = array();

		if ( ! empty( $raw_data ) ) {
			if ( is_string( $raw_data ) ) {
				$decoded = json_decode( $raw_data, true );
				$data = ( json_last_error() === JSON_ERROR_NONE && is_array( $decoded ) ) ? $decoded : array();
			} elseif ( is_array( $raw_data ) ) {
				$data = $raw_data;
			}
		}

		$template_type = '';
		if ( $post->post_type === 'elementor_library' ) {
			$template_type = get_post_meta( $post->ID, '_elementor_template_type', true );
		}

		return rest_ensure_response( array(
			'id'              => $post->ID,
			'title'           => get_the_title( $post->ID ),
			'post_type'       => $post->post_type,
			'template_type'   => $template_type,
			'url'             => get_permalink( $post->ID ),
			'modified'        => $post->post_modified_gmt,
			'_elementor_data' => $data,
		) );
	}

	/**
	 * GET /page/{id}/backups
	 */
	public function get_backups( $request ) {
		$post_id = $request->get_param( 'id' );
		$backups_list = get_post_meta( $post_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}
		return rest_ensure_response( $backups_list );
	}

	/**
	 * POST /page/{id}/patch (Gated behind ERA_ENABLE_WRITES)
	 */
	public function patch_page( $request ) {
		$post_id = $request->get_param( 'id' );
		$post = get_post( $post_id );

		if ( ! $post ) {
			return new WP_Error( 'era_post_not_found', __( 'Post not found.', 'era-bridge' ), array( 'status' => 404 ) );
		}

		$body = $request->get_json_params();
		$patches = isset( $body['patches'] ) && is_array( $body['patches'] ) ? $body['patches'] : $body;
		$allow_hiding = ! empty( $body['allow_hiding'] );

		if ( ! is_array( $patches ) || empty( $patches ) ) {
			return new WP_Error( 'era_invalid_patches', __( 'Patches array is required and cannot be empty.', 'era-bridge' ), array( 'status' => 400 ) );
		}

		// Validation
		foreach ( $patches as $patch ) {
			if ( empty( $patch['element_id'] ) || ! is_string( $patch['element_id'] ) ) {
				return new WP_Error( 'era_invalid_patch_element', __( 'Every patch must contain a valid element_id string.', 'era-bridge' ), array( 'status' => 400 ) );
			}
			if ( empty( $patch['settings'] ) || ! is_array( $patch['settings'] ) ) {
				return new WP_Error( 'era_invalid_patch_settings', __( 'Every patch must contain a settings object.', 'era-bridge' ), array( 'status' => 400 ) );
			}

			foreach ( $patch['settings'] as $key => $val ) {
				// Rule 2 exception check
				if ( $key === 'typography_typography' && $val === 'custom' ) {
					continue;
				}

				$is_responsive = false;
				foreach ( $this->allowed_suffixes as $suffix ) {
					if ( substr( $key, -strlen( $suffix ) ) === $suffix ) {
						$is_responsive = true;
						break;
					}
				}

				if ( ! $is_responsive ) {
					return new WP_Error(
						'era_rule_2_violation',
						sprintf( __( 'Hard Rule 2 Violation: Setting key "%s" is rejected.', 'era-bridge' ), esc_html( $key ) ),
						array( 'status' => 422 )
					);
				}

				if ( in_array( $key, $this->hide_keys, true ) && ! $allow_hiding ) {
					return new WP_Error(
						'era_rule_7_violation',
						sprintf( __( 'Hard Rule 7 Violation: Hiding key "%s" is rejected.', 'era-bridge' ), esc_html( $key ) ),
						array( 'status' => 422 )
					);
				}
			}
		}

		$raw_data = get_post_meta( $post_id, '_elementor_data', true );
		$original_raw = is_string( $raw_data ) ? $raw_data : wp_json_encode( $raw_data );
		$tree = json_decode( $original_raw, true );
		if ( ! is_array( $tree ) ) {
			$tree = array();
		}

		// Create Backup
		$timestamp = time();
		$backup_key = '_era_backup_' . $timestamp;

		update_post_meta( $post_id, $backup_key, wp_slash( $original_raw ) );

		$backups_list = get_post_meta( $post_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}
		$backups_list[] = array(
			'key'       => $backup_key,
			'timestamp' => $timestamp,
			'date_gmt'  => gmdate( 'Y-m-d H:i:s', $timestamp ),
		);
		update_post_meta( $post_id, '_era_backups_list', $backups_list );

		$upload_dir = wp_upload_dir();
		$era_dir = $upload_dir['basedir'] . '/era-backups/page-' . $post_id;
		if ( ! file_exists( $era_dir ) ) {
			wp_mkdir_p( $era_dir );
		}
		$backup_file = $era_dir . '/' . $backup_key . '.json';
		@file_put_contents( $backup_file, $original_raw );

		// Apply Patches
		$applied_diff = array();
		$tree_after = $this->apply_patches_to_tree( $tree, $patches, $applied_diff );

		// Save
		$encoded_new_data = wp_json_encode( $tree_after );
		update_post_meta( $post_id, '_elementor_data', wp_slash( $encoded_new_data ) );

		// Clear Cache & Run Purges
		$purges_run = $this->clear_elementor_and_plugin_caches( $post_id );

		return rest_ensure_response( array(
			'success'      => true,
			'page_id'      => $post_id,
			'backup_key'   => $backup_key,
			'applied_diff' => $applied_diff,
			'purges_run'   => $purges_run,
			'patched_at'   => gmdate( 'Y-m-d H:i:s', $timestamp ),
		) );
	}

	/**
	 * POST /page/{id}/restore (Gated behind ERA_ENABLE_WRITES)
	 */
	public function restore_page( $request ) {
		$post_id = $request->get_param( 'id' );
		$post = get_post( $post_id );

		if ( ! $post ) {
			return new WP_Error( 'era_post_not_found', __( 'Post not found.', 'era-bridge' ), array( 'status' => 404 ) );
		}

		$body = $request->get_json_params();
		$backup_key = isset( $body['backup_key'] ) ? sanitize_text_field( $body['backup_key'] ) : '';

		if ( empty( $backup_key ) ) {
			$backups_list = get_post_meta( $post_id, '_era_backups_list', true );
			if ( is_array( $backups_list ) && ! empty( $backups_list ) ) {
				$last = end( $backups_list );
				$backup_key = $last['key'];
			}
		}

		if ( empty( $backup_key ) ) {
			return new WP_Error( 'era_backup_missing', __( 'No backup key specified.', 'era-bridge' ), array( 'status' => 400 ) );
		}

		$backup_raw = get_post_meta( $post_id, $backup_key, true );
		if ( empty( $backup_raw ) ) {
			$upload_dir = wp_upload_dir();
			$backup_file = $upload_dir['basedir'] . '/era-backups/page-' . $post_id . '/' . $backup_key . '.json';
			if ( file_exists( $backup_file ) ) {
				$backup_raw = file_get_contents( $backup_file );
			}
		}

		if ( empty( $backup_raw ) ) {
			return new WP_Error( 'era_backup_not_found', __( 'Backup not found.', 'era-bridge' ), array( 'status' => 404 ) );
		}

		update_post_meta( $post_id, '_elementor_data', wp_slash( $backup_raw ) );
		$purges_run = $this->clear_elementor_and_plugin_caches( $post_id );

		return rest_ensure_response( array(
			'success'      => true,
			'page_id'      => $post_id,
			'restored_key' => $backup_key,
			'purges_run'   => $purges_run,
			'restored_at'  => gmdate( 'Y-m-d H:i:s' ),
		) );
	}

	private function apply_patches_to_tree( $elements, $patches, &$applied_diff ) {
		$patches_by_id = array();
		foreach ( $patches as $p ) {
			$patches_by_id[ $p['element_id'] ] = $p['settings'];
		}

		return $this->traverse_and_merge( $elements, $patches_by_id, $applied_diff );
	}

	private function traverse_and_merge( $elements, $patches_by_id, &$applied_diff ) {
		if ( ! is_array( $elements ) ) {
			return $elements;
		}

		foreach ( $elements as &$el ) {
			if ( ! is_array( $el ) ) {
				continue;
			}

			$el_id = isset( $el['id'] ) ? $el['id'] : '';
			if ( ! empty( $el_id ) && isset( $patches_by_id[ $el_id ] ) ) {
				if ( ! isset( $el['settings'] ) || ! is_array( $el['settings'] ) ) {
					$el['settings'] = array();
				}

				$patch_settings = $patches_by_id[ $el_id ];
				$diff_entry = array(
					'element_id' => $el_id,
					'before'     => array(),
					'after'      => array(),
				);

				foreach ( $patch_settings as $key => $new_val ) {
					$before_val = isset( $el['settings'][ $key ] ) ? $el['settings'][ $key ] : null;
					$el['settings'][ $key ] = $new_val;
					$diff_entry['before'][ $key ] = $before_val;
					$diff_entry['after'][ $key ] = $new_val;
				}

				$applied_diff[] = $diff_entry;
			}

			if ( isset( $el['elements'] ) && is_array( $el['elements'] ) ) {
				$el['elements'] = $this->traverse_and_merge( $el['elements'], $patches_by_id, $applied_diff );
			}
		}

		return $elements;
	}

	private function clear_elementor_and_plugin_caches( $post_id ) {
		$purges = array();

		delete_post_meta( $post_id, '_elementor_css' );
		$purges[] = '_elementor_css post meta deleted';

		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
			$purges[] = 'Elementor files_manager::clear_cache()';
		}

		if ( function_exists( 'rocket_clean_domain' ) ) {
			rocket_clean_domain();
			$purges[] = 'WP Rocket (rocket_clean_domain)';
		}

		if ( has_action( 'litespeed_purge_all' ) ) {
			do_action( 'litespeed_purge_all' );
			$purges[] = 'LiteSpeed Cache (litespeed_purge_all)';
		}

		if ( class_exists( 'autoptimizeCache' ) && method_exists( 'autoptimizeCache', 'clearall' ) ) {
			autoptimizeCache::clearall();
			$purges[] = 'Autoptimize (autoptimizeCache::clearall)';
		}

		if ( function_exists( 'w3tc_flush_all' ) ) {
			w3tc_flush_all();
			$purges[] = 'W3 Total Cache (w3tc_flush_all)';
		}

		if ( function_exists( 'wp_cache_flush' ) ) {
			wp_cache_flush();
			$purges[] = 'WordPress Object Cache (wp_cache_flush)';
		}

		if ( has_action( 'wpfc_clear_all_cache' ) ) {
			do_action( 'wpfc_clear_all_cache' );
			$purges[] = 'WP Fastest Cache (wpfc_clear_all_cache)';
		}

		return $purges;
	}
}
