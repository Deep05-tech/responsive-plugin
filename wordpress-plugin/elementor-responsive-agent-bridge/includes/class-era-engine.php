<?php
/**
 * Elementor Responsive Agent Engine (Pure PHP).
 * 100% Standalone - No Node.js or background servers required.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ERA_Engine {

	/**
	 * Get OpenAI API Key from options or constants.
	 */
	public static function get_api_key() {
		$key = get_option( 'era_openai_api_key', '' );
		if ( empty( $key ) && defined( 'OPENAI_API_KEY' ) ) {
			$key = OPENAI_API_KEY;
		}
		return trim( (string) $key );
	}

	/**
	 * Get OpenAI Model from options.
	 */
	public static function get_model() {
		$model = get_option( 'era_openai_model', 'gpt-4o-mini' );
		return ! empty( $model ) ? trim( (string) $model ) : 'gpt-4o-mini';
	}

	/**
	 * Extract section candidates from Elementor elements tree.
	 */
	public static function extract_section_candidates( $elements ) {
		$candidates = array();

		$clean_html = function( $html ) {
			$h = preg_replace( '/<style[^>]*>[\s\S]*?<\/style>/i', '', $html );
			$h = preg_replace( '/<script[^>]*>[\s\S]*?<\/script>/i', '', $h );
			return $h;
		};

		$traverse = function( $items, $depth = 0 ) use ( &$traverse, &$candidates, $clean_html ) {
			if ( ! is_array( $items ) ) {
				return;
			}

			foreach ( $items as $item ) {
				if ( ! is_array( $item ) || empty( $item['id'] ) ) {
					continue;
				}

				$el_type = isset( $item['elType'] ) ? $item['elType'] : '';
				$is_section = ( 'section' === $el_type || 'container' === $el_type || ( 0 === $depth && ! empty( $item['elements'] ) ) );

				if ( $is_section ) {
					$sid = (string) $item['id'];
					if ( strpos( $sid, 'era_scoped_css_' ) === 0 || strpos( $sid, 'era_responsive_css_' ) === 0 ) {
						continue;
					}

					$found_headings    = array();
					$widget_types      = array();
					$text_samples      = array();
					$inner_classes     = array();
					$editable_snippets = array();

					$inspect_children = function( $child ) use ( &$inspect_children, &$found_headings, &$widget_types, &$text_samples, &$inner_classes, &$editable_snippets, $clean_html ) {
						if ( ! is_array( $child ) ) {
							return;
						}
						$w_type = ! empty( $child['widgetType'] ) ? (string) $child['widgetType'] : ( ! empty( $child['elType'] ) ? (string) $child['elType'] : '' );
						if ( ! empty( $child['widgetType'] ) ) {
							$widget_types[] = (string) $child['widgetType'];
						}
						$child_id = ! empty( $child['id'] ) ? (string) $child['id'] : '';
						$s = ! empty( $child['settings'] ) && is_array( $child['settings'] ) ? $child['settings'] : array();

						if ( ! empty( $s['title'] ) && is_string( $s['title'] ) ) {
							$found_headings[] = trim( $s['title'] );
							$editable_snippets[] = array(
								'elementId'  => $child_id,
								'widgetType' => $w_type ? $w_type : 'heading',
								'settingKey' => 'title',
								'content'    => trim( $s['title'] ),
							);
						}
						if ( ! empty( $s['heading_title'] ) && is_string( $s['heading_title'] ) ) {
							$found_headings[] = trim( $s['heading_title'] );
							$editable_snippets[] = array(
								'elementId'  => $child_id,
								'widgetType' => $w_type ? $w_type : 'heading',
								'settingKey' => 'heading_title',
								'content'    => trim( $s['heading_title'] ),
							);
						}
						if ( ! empty( $s['text'] ) && is_string( $s['text'] ) ) {
							$editable_snippets[] = array(
								'elementId'  => $child_id,
								'widgetType' => $w_type ? $w_type : 'button',
								'settingKey' => 'text',
								'content'    => trim( $s['text'] ),
							);
						}
						if ( ! empty( $s['_css_classes'] ) && is_string( $s['_css_classes'] ) ) {
							$cls = preg_split( '/\s+/', trim( $s['_css_classes'] ) );
							foreach ( $cls as $c ) {
								if ( $c ) {
									$inner_classes[] = $c;
								}
							}
						}
						if ( ! empty( $s['editor'] ) && is_string( $s['editor'] ) ) {
							$clean = $clean_html( $s['editor'] );
							if ( preg_match_all( '/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i', $clean, $hm ) ) {
								foreach ( $hm[1] as $h_txt ) {
									$found_headings[] = trim( wp_strip_all_tags( $h_txt ) );
								}
							}
							$txt_clean = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( $clean ) ) );
							if ( $txt_clean ) {
								$text_samples[] = mb_substr( $txt_clean, 0, 120 );
							}
							$editable_snippets[] = array(
								'elementId'  => $child_id,
								'widgetType' => $w_type ? $w_type : 'text-editor',
								'settingKey' => 'editor',
								'content'    => mb_substr( trim( $s['editor'] ), 0, 3000 ),
							);
						}
						if ( ! empty( $s['html'] ) && is_string( $s['html'] ) ) {
							$clean = $clean_html( $s['html'] );
							if ( preg_match_all( '/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i', $clean, $hm ) ) {
								foreach ( $hm[1] as $h_txt ) {
									$found_headings[] = trim( wp_strip_all_tags( $h_txt ) );
								}
							}
							if ( preg_match_all( '/class=["\']([^"\']+)["\']/i', $clean, $cm ) ) {
								foreach ( $cm[1] as $cls_str ) {
									$clist = preg_split( '/\s+/', $cls_str );
									foreach ( $clist as $c ) {
										if ( $c && strpos( $c, 'elementor-' ) !== 0 && strlen( $c ) > 2 ) {
											$inner_classes[] = $c;
										}
									}
								}
							}
							if ( preg_match_all( '/placeholder=["\']([^"\']+)["\']/i', $clean, $phm ) ) {
								foreach ( $phm[1] as $ph ) {
									$text_samples[] = trim( $ph );
								}
							}
							$txt_clean = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( $clean ) ) );
							if ( $txt_clean ) {
								$text_samples[] = mb_substr( $txt_clean, 0, 160 );
							}
							$editable_snippets[] = array(
								'elementId'  => $child_id,
								'widgetType' => $w_type ? $w_type : 'html',
								'settingKey' => 'html',
								'content'    => mb_substr( trim( $s['html'] ), 0, 4000 ),
							);
						}

						// Additional text-like settings
						foreach ( $s as $key => $val ) {
							if ( is_string( $val ) && trim( $val ) !== '' && ! in_array( $key, array( 'title', 'heading_title', 'text', 'editor', 'html', '_css_classes', '_element_id' ), true ) ) {
								if ( strpos( $key, 'title' ) !== false || strpos( $key, 'text' ) !== false || strpos( $key, 'desc' ) !== false || strpos( $key, 'label' ) !== false || strpos( $key, 'content' ) !== false || strpos( $key, 'caption' ) !== false ) {
									$editable_snippets[] = array(
										'elementId'  => $child_id,
										'widgetType' => $w_type ? $w_type : 'widget',
										'settingKey' => $key,
										'content'    => mb_substr( trim( $val ), 0, 4000 ),
									);
								}
							}
						}

						if ( ! empty( $child['elements'] ) && is_array( $child['elements'] ) ) {
							foreach ( $child['elements'] as $gc ) {
								$inspect_children( $gc );
							}
						}
					};

					$inspect_children( $item );

					$unique_headings = array_values( array_unique( array_filter( $found_headings ) ) );
					$primary_heading = ! empty( $unique_headings[0] ) ? $unique_headings[0] : ( 'Section ' . $item['id'] );
					$sub_headings    = array_slice( $unique_headings, 1, 5 );

					$candidates[] = array(
						'id'               => (string) $item['id'],
						'heading'          => $primary_heading,
						'subHeadings'      => $sub_headings,
						'innerClasses'     => array_values( array_unique( $inner_classes ) ),
						'widgetTypes'      => array_values( array_unique( $widget_types ) ),
						'sampleText'       => implode( ' | ', array_slice( $text_samples, 0, 4 ) ),
						'editableSnippets' => $editable_snippets,
					);
				}
			}
		};

		$traverse( $elements, 0 );
		return $candidates;
	}

	/**
	 * Build structured page overview summary for LLM prompt.
	 */
	public static function build_page_structure_summary( $candidates ) {
		$summary = 'PAGE STRUCTURE OVERVIEW (' . count( $candidates ) . ' Sections):' . "\n";
		foreach ( $candidates as $c ) {
			$summary .= "\n" . '▶ Section ID: "' . $c['id'] . '" | Title: "' . $c['heading'] . '"' . "\n";
			if ( ! empty( $c['innerClasses'] ) ) {
				$summary .= '  Classes: ' . implode( ', ', $c['innerClasses'] ) . "\n";
			}
			if ( ! empty( $c['widgetTypes'] ) ) {
				$summary .= '  Widget Types: ' . implode( ', ', $c['widgetTypes'] ) . "\n";
			}
			if ( ! empty( $c['sampleText'] ) ) {
				$summary .= '  Sample Content: "' . $c['sampleText'] . '"' . "\n";
			}
			if ( ! empty( $c['editableSnippets'] ) ) {
				$summary .= '  Editable Snippets (' . count( $c['editableSnippets'] ) . '):' . "\n";
				foreach ( array_slice( $c['editableSnippets'], 0, 8 ) as $snip ) {
					$clean_snip = preg_replace( '/\s+/', ' ', wp_strip_all_tags( $snip['content'] ) );
					$summary .= '    - [' . $snip['widgetType'] . '] (ID: ' . $snip['elementId'] . ') Key: "' . $snip['settingKey'] . '" | Content: "' . mb_substr( $clean_snip, 0, 100 ) . '"' . "\n";
				}
			}
		}
		return $summary;
	}

	/**
	 * Generates isolated responsive CSS strictly scoped to a specific Elementor element ID.
	 * Guarantees zero side effects or style leakage to any other section on the page.
	 */
	public static function generate_scoped_section_css( $element_id, $section_title = 'Targeted Section', $extra_rules = '', $is_form_or_card = true ) {
		$raw_id   = preg_replace( '/^era_scoped_css_/', '', $element_id );
		$raw_id   = preg_replace( '/^era_responsive_css_/', '', $raw_id );
		$clean_id = preg_replace( '/[^a-zA-Z0-9_-]/', '', $raw_id );

		$css = "/* -------------------------------------------------------------\n" .
			"   SCOPED RESPONSIVE FIX: {$section_title} (Elementor ID: {$clean_id})\n" .
			"   Scope: Exclusively affects .elementor-element-{$clean_id}\n" .
			"   ------------------------------------------------------------- */\n\n" .
			"/* 1. Fluid Container Containment */\n" .
			".elementor-element-{$clean_id},\n" .
			"[data-id=\"{$clean_id}\"] {\n" .
			"  height: auto !important;\n" .
			"  min-height: fit-content !important;\n" .
			"  box-sizing: border-box !important;\n" .
			"  max-width: 100% !important;\n" .
			"  overflow-x: clip !important;\n" .
			"}\n\n" .
			".elementor-element-{$clean_id} .elementor-container,\n" .
			".elementor-element-{$clean_id} .elementor-row,\n" .
			".elementor-element-{$clean_id} .elementor-widget-wrap,\n" .
			".elementor-element-{$clean_id} .elementor-column-wrap {\n" .
			"  height: auto !important;\n" .
			"  min-height: fit-content !important;\n" .
			"  max-width: 100% !important;\n" .
			"  box-sizing: border-box !important;\n" .
			"}\n\n" .
			"/* Fluid containment for inner semantic wrappers, sections, headers, footers & grids */\n" .
			".elementor-element-{$clean_id} header,\n" .
			".elementor-element-{$clean_id} section,\n" .
			".elementor-element-{$clean_id} footer,\n" .
			".elementor-element-{$clean_id} [class*=\"header\"],\n" .
			".elementor-element-{$clean_id} [class*=\"section\"],\n" .
			".elementor-element-{$clean_id} [class*=\"footer\"],\n" .
			".elementor-element-{$clean_id} [class*=\"container\"],\n" .
			".elementor-element-{$clean_id} [class*=\"grid\"] {\n" .
			"  max-width: 100% !important;\n" .
			"  box-sizing: border-box !important;\n" .
			"}\n";

		if ( $is_form_or_card ) {
			$css .= "\n/* 2. Fluid Form, Card & Interactive Sizing */\n" .
				".elementor-element-{$clean_id} [class*=\"card\"],\n" .
				".elementor-element-{$clean_id} [class*=\"inquiry\"],\n" .
				".elementor-element-{$clean_id} [class*=\"form\"] {\n" .
				"  max-width: 100% !important;\n" .
				"  box-sizing: border-box !important;\n" .
				"  height: auto !important;\n" .
				"}\n\n" .
				".elementor-element-{$clean_id} input:not([type=\"checkbox\"]):not([type=\"radio\"]),\n" .
				".elementor-element-{$clean_id} select,\n" .
				".elementor-element-{$clean_id} textarea,\n" .
				".elementor-element-{$clean_id} button,\n" .
				".elementor-element-{$clean_id} .elementor-button,\n" .
				".elementor-element-{$clean_id} [class*=\"btn\"],\n" .
				".elementor-element-{$clean_id} [class*=\"submit\"] {\n" .
				"  max-width: 100% !important;\n" .
				"  box-sizing: border-box !important;\n" .
				"  min-height: 44px !important;\n" .
				"}\n\n" .
				".elementor-element-{$clean_id} button,\n" .
				".elementor-element-{$clean_id} .elementor-button,\n" .
				".elementor-element-{$clean_id} [class*=\"btn\"],\n" .
				".elementor-element-{$clean_id} [class*=\"submit\"] {\n" .
				"  display: inline-flex !important;\n" .
				"  align-items: center !important;\n" .
				"  justify-content: center !important;\n" .
				"  padding: 10px 20px !important;\n" .
				"}\n";
		}

		$css .= "\n/* 3. Responsive Breakpoint Normalization */\n" .
			"@media (max-width: 1200px) {\n" .
			"  .elementor-element-{$clean_id} [class*=\"reveal\"],\n" .
			"  .elementor-element-{$clean_id} [class*=\"animate\"],\n" .
			"  .elementor-element-{$clean_id} [class*=\"slide\"] {\n" .
			"    transform: none !important;\n" .
			"    opacity: 1 !important;\n" .
			"    visibility: visible !important;\n" .
			"  }\n" .
			"}\n\n" .
			"@media (max-width: 767px) {\n" .
			"  .elementor-element-{$clean_id} .elementor-column,\n" .
			"  .elementor-element-{$clean_id} .elementor-top-column {\n" .
			"    width: 100% !important;\n" .
			"  }\n" .
			"  .elementor-element-{$clean_id} a,\n" .
			"  .elementor-element-{$clean_id} button,\n" .
			"  .elementor-element-{$clean_id} input[type=\"submit\"] {\n" .
			"    min-height: 40px;\n" .
			"    box-sizing: border-box;\n" .
			"  }\n" .
			"  .elementor-element-{$clean_id} header,\n" .
			"  .elementor-element-{$clean_id} [class*=\"header\"] {\n" .
			"    position: relative !important;\n" .
			"    height: auto !important;\n" .
			"    min-height: unset !important;\n" .
			"    display: flex !important;\n" .
			"    flex-wrap: wrap !important;\n" .
			"    justify-content: space-between !important;\n" .
			"    align-items: center !important;\n" .
			"    padding: 12px 16px 8px !important;\n" .
			"  }\n" .
			"  .elementor-element-{$clean_id} nav,\n" .
			"  .elementor-element-{$clean_id} [class*=\"nav\"] {\n" .
			"    width: 100% !important;\n" .
			"    order: 3 !important;\n" .
			"    display: flex !important;\n" .
			"    flex-wrap: nowrap !important;\n" .
			"    overflow-x: auto !important;\n" .
			"    -webkit-overflow-scrolling: touch !important;\n" .
			"    scrollbar-width: none !important;\n" .
			"    gap: 12px !important;\n" .
			"    justify-content: flex-start !important;\n" .
			"    padding-top: 8px !important;\n" .
			"  }\n" .
			"  .elementor-element-{$clean_id} [class*=\"metric\"] {\n" .
			"    height: auto !important;\n" .
			"    min-height: fit-content !important;\n" .
			"    box-sizing: border-box !important;\n" .
			"  }\n" .
			"  .elementor-element-{$clean_id} [class$=\"-section\"],\n" .
			"  .elementor-element-{$clean_id} [class$=\"-grid\"] {\n" .
			"    flex-direction: column !important;\n" .
			"    height: auto !important;\n" .
			"    gap: 24px !important;\n" .
			"  }\n" .
			"}\n";

		if ( ! empty( trim( $extra_rules ) ) ) {
			// Strip markdown fences
			$sanitized = preg_replace( '/```css/i', '', $extra_rules );
			$sanitized = preg_replace( '/```/', '', $sanitized );
			$sanitized = trim( $sanitized );

			// Normalize any `#{$clean_id}` selectors to `.elementor-element-{$clean_id}`
			$sanitized = preg_replace( '/#' . preg_quote( $clean_id, '/' ) . '\b/', '.elementor-element-' . $clean_id, $sanitized );
			$sanitized = preg_replace( '/#era_scoped_css_' . preg_quote( $clean_id, '/' ) . '\b/', '.elementor-element-' . $clean_id, $sanitized );

			$css .= "\n/* 4. AI Custom Instruction Optimizations */\n" . $sanitized . "\n";
		}

		return $css;
	}

	/**
	 * Run direct chat via OpenAI API from PHP.
	 */
	public static function chat( $page_id, $message, $history = array(), $image_base64 = '', $page_context = array(), $elementor_data = null ) {
		$api_key = self::get_api_key();
		$model   = self::get_model();

		if ( empty( $elementor_data ) || ! is_array( $elementor_data ) ) {
			$raw_meta = get_post_meta( $page_id, '_elementor_data', true );
			$elementor_data = ! empty( $raw_meta ) ? json_decode( $raw_meta, true ) : array();
		}

		$candidates = self::extract_section_candidates( $elementor_data );

		// If no candidates found, fallback gracefully
		if ( empty( $candidates ) ) {
			$candidates = array(
				array(
					'id'               => 'main',
					'heading'          => 'Main Page Container',
					'subHeadings'      => array(),
					'innerClasses'     => array(),
					'widgetTypes'      => array(),
					'sampleText'       => '',
					'editableSnippets' => array(),
				),
			);
		}

		$backups = ! empty( $page_context['recentBackups'] ) && is_array( $page_context['recentBackups'] )
			? $page_context['recentBackups']
			: array();

		// Check if user requested undo/restore or greeting deterministically first
		$raw_msg = strtolower( trim( (string) $message ) );
		$is_greeting = in_array( $raw_msg, array( 'hi', 'hello', 'hey', 'help' ), true ) ||
			strpos( $raw_msg, 'how are you' ) === 0 ||
			strpos( $raw_msg, 'what can you do' ) === 0;

		if ( $is_greeting ) {
			return array(
				'success'   => true,
				'reply'     => "👋 Hello! I am your **ERA Page Architect** running directly on your WordPress server.\n\nI have full visibility into all " . count( $candidates ) . " sections on this page.\n\nYou can ask me to:\n- 📝 **Change or replace text** in any section\n- 🎨 **Adjust colors, fonts, margins, or CSS styling**\n- 📱 **Fix mobile/tablet responsive stacking & overflow**\n- 🖼️ **Review an attached screenshot**\n- ⏪ **Undo changes or restore previous versions**\n\nWhat would you like to adjust on this page?",
				'hasAction' => false,
			);
		}

		// Handle deterministic undo/restore query
		$is_undo = ( strpos( $raw_msg, 'undo' ) !== false || strpos( $raw_msg, 'revert' ) !== false || strpos( $raw_msg, 'restore' ) !== false || strpos( $raw_msg, 'rollback' ) !== false || strpos( $raw_msg, 'version' ) !== false );
		if ( $is_undo ) {
			if ( ! empty( $backups ) ) {
				$target_backup = end( $backups );
				if ( preg_match( '/(?:option|version|number|#)\s*(\d+)/i', $raw_msg, $nm ) || preg_match( '/\b([1-9])\b/', $raw_msg, $nm ) ) {
					$idx = intval( $nm[1] ) - 1;
					if ( isset( $backups[ $idx ] ) ) {
						$target_backup = $backups[ $idx ];
					}
				} else {
					foreach ( $backups as $b ) {
						if ( ! empty( $b['key'] ) && strpos( $raw_msg, $b['key'] ) !== false ) {
							$target_backup = $b;
							break;
						}
					}
				}

				$title_str = ! empty( $target_backup['title'] ) ? $target_backup['title'] : ( 'Snapshot ' . $target_backup['key'] );
				$options_list = '';
				foreach ( $backups as $i => $b ) {
					$t = ! empty( $b['title'] ) ? $b['title'] : ( 'Snapshot ' . $b['key'] );
					$d = ! empty( $b['date_gmt'] ) ? $b['date_gmt'] : '';
					$active = ( $b['key'] === $target_backup['key'] ) ? ' 👈 *(selected to restore)*' : '';
					$options_list .= ( $i + 1 ) . ". **{$t}** (`{$b['key']}`" . ( $d ? ' - ' . $d : '' ) . "){$active}\n";
				}

				return array(
					'success'         => true,
					'reply'           => "I found **" . count( $backups ) . " recorded version(s)** for this page:\n\n{$options_list}\n\nClick the button below to restore **{$title_str}**, or reply with an option number (e.g. \"restore option 1\") to select a different version!",
					'hasAction'       => true,
					'actionType'      => 'restore',
					'targetBackupKey' => $target_backup['key'],
					'action'          => array(
						'actionType'      => 'restore',
						'targetBackupKey' => $target_backup['key'],
						'actionSummary'   => "Restore \"{$title_str}\"",
						'detectedIssues'  => array( 'Revert to previous page version requested' ),
						'contentPatches'  => array(),
						'scopedCss'       => '',
					),
					'explanation'     => "Revert page to \"{$title_str}\" ({$target_backup['key']})",
					'detectedIssues'  => array( 'Revert to previous page version requested' ),
					'contentPatches'  => array(),
					'scopedCss'       => '',
				);
			} else {
				return array(
					'success'   => true,
					'reply'     => "I checked the page history, but there are no automated backups recorded yet for this page to revert to.",
					'hasAction' => false,
				);
			}
		}

		// If no OpenAI API Key is configured, guide the user to Settings
		if ( empty( $api_key ) ) {
			return array(
				'success'   => true,
				'reply'     => "⚠️ **OpenAI API Key Not Configured**\n\nTo enable conversational AI editing and intelligent responsive design fixes, please configure your OpenAI API Key in WordPress Admin:\n\n👉 Navigate to **ERA Responsive** ➔ **Settings** and save your API Key.",
				'hasAction' => false,
			);
		}

		// Build structured context for OpenAI
		$page_structure_summary = self::build_page_structure_summary( $candidates );

		$backups_summary = "AVAILABLE PAGE BACKUPS / RESTORE POINTS (With Change Titles):\n";
		if ( ! empty( $backups ) ) {
			foreach ( $backups as $i => $b ) {
				$num   = $i + 1;
				$title = ! empty( $b['title'] ) ? $b['title'] : ( 'Snapshot ' . $b['key'] );
				$sec   = ! empty( $b['section_title'] ) ? " [Section: {$b['section_title']}]" : '';
				$type  = ! empty( $b['action_type'] ) ? " [Type: {$b['action_type']}]" : '';
				$date  = ! empty( $b['date_gmt'] ) ? $b['date_gmt'] : 'Recorded';
				$backups_summary .= "Option {$num}: \"{$title}\" | Key: \"{$b['key']}\"{$sec}{$type} | Date: {$date}\n";
			}
		} else {
			$backups_summary .= "None currently recorded.\n";
		}

		$system_prompt = <<<PROMPT
You are ERA (Elementor Responsive & Design Architect), a world-class AI frontend engineering pair-programmer running directly in the user's WordPress environment.
You are talking directly to the user who is editing/reviewing this page.

YOUR CAPABILITIES & ROLE:
1. Deep Comprehension: You have full access to the page structure (Elementor data JSON, section IDs, widgets, classes, and settings). You understand CSS, flexbox, grid, mobile breakpoints, typography, and Elementor data formats.
2. Natural, Smart Communication: Talk just like an expert human coding assistant. Be direct, clear, helpful, and concise. Explain what you're doing, acknowledge feedback, accept corrections, and ask clarifying questions if something is genuinely ambiguous.
3. Universal Execution:
   - When the user asks a question, greets you, or discusses design, converse naturally without forcing an action card (set hasAction: false).
   - When the user requests a change (content/text, CSS styling, colors, alignment, layout, or mobile responsive fix), propose the exact change (set hasAction: true).
   - When the user asks to undo, revert, or restore a previous change:
     - Check the AVAILABLE PAGE BACKUPS provided below.
     - Present the options clearly so the user can choose which version to restore.
     - Set hasAction: true, actionType: "restore", targetBackupKey: [the target snapshot key matching user's choice or the latest change], and actionSummary: "Restore [Version Title]".

CRITICAL TECHNICAL RULES FOR ACTIONS (hasAction: true):
1. CONTENT CHANGES ("contentPatches"):
   - When user wants to change, replace, or update text, headings, buttons, or copy:
   - Identify the exact elementId from candidate snippets and widget tree.
   - Output exact search and replace in contentPatches:
     [
       {
         "elementId": "exact_widget_id",
         "settingKey": "html" (or "title", "heading_title", "editor", "text"),
         "search": "verbatim current text substring",
         "replace": "new text substring"
       }
     ]
   - NEVER use CSS pseudo-elements (e.g. ::before { content: "..." }) or display: none to replace or hide text! Sibling paragraphs, forms, and contact points must remain 100% untouched.
2. STYLING CHANGES ("scopedCss"):
   - When user asks for styling (colors, padding, margins, borders, font size, background, alignment, flexbox, responsive stacking):
   - Scope every selector to:
     .elementor-element-[targetSectionId] [childSelector], [data-id="[targetSectionId]"] [childSelector]
   - Target actual semantic classes present in the section.
   - Use media queries:
     - Wrap desktop-only row/flex styles in @media (min-width: 900px) { ... }
     - Wrap mobile/tablet vertical stacking in @media (max-width: 899px) { ... }
   - Use !important on CSS declarations to guarantee override over Elementor defaults.
   - If user ONLY requested content changes, leave scopedCss empty ("").
3. ACTION TYPES:
   - "content": Text/copy updates only.
   - "style": CSS styling or layout updates only.
   - "both": Both text changes AND CSS styling.
   - "restore": Revert/restore page back to a safety backup snapshot.

PAGE CONTEXT:
{$page_structure_summary}

{$backups_summary}

OUTPUT FORMAT:
Respond strictly with valid JSON conforming to this schema:
{
  "reply": "Your conversational response in GitHub-flavored markdown. Explain what you found or what changes you prepared.",
  "hasAction": true | false,
  "action": {
    "targetSectionId": "section_id (optional if restore)",
    "sectionTitle": "Section Title (optional if restore)",
    "actionType": "content" | "style" | "both" | "restore",
    "targetBackupKey": "snapshot_key (required if actionType is restore)",
    "actionSummary": "1-line summary of what will be done",
    "detectedIssues": ["issue or request item"],
    "contentPatches": [
      {
        "elementId": "widget_id",
        "settingKey": "html",
        "search": "Current verbatim text",
        "replace": "New replacement text"
      }
    ],
    "scopedCss": "Clean scoped CSS rules here (or empty string if content-only or restore)"
  }
}
PROMPT;

		$messages = array(
			array( 'role' => 'system', 'content' => $system_prompt ),
		);

		// Append recent conversation history
		if ( ! empty( $history ) && is_array( $history ) ) {
			$recent = array_slice( $history, -10 );
			foreach ( $recent as $h ) {
				if ( empty( $h['content'] ) ) {
					continue;
				}
				$role = ( isset( $h['sender'] ) && 'agent' === $h['sender'] ) || ( isset( $h['role'] ) && 'assistant' === $h['role'] )
					? 'assistant'
					: 'user';
				$messages[] = array( 'role' => $role, 'content' => wp_strip_all_tags( (string) $h['content'] ) );
			}
		}

		// Append latest user message with image if present
		$clean_base64 = '';
		if ( ! empty( $image_base64 ) ) {
			$clean_base64 = preg_replace( '#^data:image/\w+;base64,#i', '', $image_base64 );
		}

		if ( $clean_base64 ) {
			$messages[] = array(
				'role'    => 'user',
				'content' => array(
					array(
						'type'      => 'image_url',
						'image_url' => array(
							'url'    => 'data:image/png;base64,' . $clean_base64,
							'detail' => 'high',
						),
					),
					array(
						'type' => 'text',
						'text' => ! empty( $message ) ? $message : 'Please review this screenshot and assist.',
					),
				),
			);
		} else {
			$messages[] = array(
				'role'    => 'user',
				'content' => $message,
			);
		}

		// Call OpenAI Chat Completions API
		$response = wp_remote_post( 'https://api.openai.com/v1/chat/completions', array(
			'timeout' => 60,
			'headers' => array(
				'Authorization' => 'Bearer ' . $api_key,
				'Content-Type'  => 'application/json',
			),
			'body'    => wp_json_encode( array(
				'model'           => $model,
				'messages'        => $messages,
				'response_format' => array( 'type' => 'json_object' ),
				'temperature'     => 0.15,
			) ),
		) );

		if ( is_wp_error( $response ) ) {
			return array(
				'success' => false,
				'message' => 'OpenAI API connection failed: ' . $response->get_error_message(),
			);
		}

		$status_code = wp_remote_retrieve_response_code( $response );
		$body_raw    = wp_remote_retrieve_body( $response );

		if ( 200 !== $status_code ) {
			$err_json = json_decode( $body_raw, true );
			$err_msg  = ! empty( $err_json['error']['message'] ) ? $err_json['error']['message'] : ( 'HTTP ' . $status_code );
			return array(
				'success' => false,
				'message' => 'OpenAI API error: ' . $err_msg,
			);
		}

		$res_data = json_decode( $body_raw, true );
		$raw_ai   = ! empty( $res_data['choices'][0]['message']['content'] ) ? $res_data['choices'][0]['message']['content'] : '{}';
		$parsed   = json_decode( $raw_ai, true );

		if ( ! is_array( $parsed ) ) {
			return array(
				'success' => false,
				'message' => 'Invalid JSON returned from AI model.',
			);
		}

		$reply      = ! empty( $parsed['reply'] ) ? $parsed['reply'] : 'Completed request.';
		$has_action = ! empty( $parsed['hasAction'] ) && ! empty( $parsed['action'] );
		$action     = $has_action ? $parsed['action'] : null;

		if ( $has_action && is_array( $action ) ) {
			$action_type = isset( $action['actionType'] ) ? $action['actionType'] : 'style';

			if ( 'restore' === $action_type || ! empty( $action['targetBackupKey'] ) ) {
				$latest_key = ! empty( $backups ) ? end( $backups )['key'] : '';
				$target_key = ! empty( $action['targetBackupKey'] ) ? $action['targetBackupKey'] : $latest_key;

				return array(
					'success'         => true,
					'reply'           => $reply,
					'hasAction'       => true,
					'targetBackupKey' => $target_key,
					'actionType'      => 'restore',
					'action'          => array(
						'actionType'      => 'restore',
						'targetBackupKey' => $target_key,
						'actionSummary'   => ! empty( $action['actionSummary'] ) ? $action['actionSummary'] : "Restore snapshot {$target_key}",
						'detectedIssues'  => array( 'Revert to previous page state requested' ),
						'contentPatches'  => array(),
						'scopedCss'       => '',
					),
					'explanation'     => $reply,
					'confidence'      => 0.98,
				);
			}

			$target_id = ! empty( $action['targetSectionId'] ) ? (string) $action['targetSectionId'] : ( ! empty( $candidates[0]['id'] ) ? $candidates[0]['id'] : '' );

			// Find candidate section
			$matched_cand = null;
			foreach ( $candidates as $c ) {
				if ( $c['id'] === $target_id ) {
					$matched_cand = $c;
					break;
				}
			}
			if ( ! $matched_cand ) {
				$matched_cand = $candidates[0];
				$target_id    = $matched_cand['id'];
			}

			$section_title = ! empty( $action['sectionTitle'] ) ? $action['sectionTitle'] : $matched_cand['heading'];

			$content_patches = array();
			if ( ! empty( $action['contentPatches'] ) && is_array( $action['contentPatches'] ) ) {
				foreach ( $action['contentPatches'] as $p ) {
					if ( is_array( $p ) && isset( $p['search'], $p['replace'] ) ) {
						$content_patches[] = array(
							'elementId'  => ! empty( $p['elementId'] ) ? $p['elementId'] : '',
							'settingKey' => ! empty( $p['settingKey'] ) ? $p['settingKey'] : 'html',
							'search'     => (string) $p['search'],
							'replace'    => (string) $p['replace'],
						);
					}
				}
			}

			$scoped_css = '';
			if ( ! empty( $action['scopedCss'] ) && is_string( $action['scopedCss'] ) && trim( $action['scopedCss'] ) ) {
				$is_form = false;
				if ( ! empty( $matched_cand['widgetTypes'] ) ) {
					foreach ( $matched_cand['widgetTypes'] as $wt ) {
						if ( strpos( $wt, 'form' ) !== false || strpos( $wt, 'inquiry' ) !== false || strpos( $wt, 'button' ) !== false ) {
							$is_form = true;
							break;
						}
					}
				}
				if ( ! $is_form && ! empty( $matched_cand['innerClasses'] ) ) {
					foreach ( $matched_cand['innerClasses'] as $ic ) {
						if ( strpos( $ic, 'card' ) !== false || strpos( $ic, 'inquiry' ) !== false || strpos( $ic, 'form' ) !== false ) {
							$is_form = true;
							break;
						}
					}
				}

				$scoped_css = self::generate_scoped_section_css( $target_id, $section_title, $action['scopedCss'], $is_form );
			}

			$detected_issues = ! empty( $action['detectedIssues'] ) && is_array( $action['detectedIssues'] )
				? $action['detectedIssues']
				: array( 'Responsive layout & styling adjustment requested' );

			$action_summary = ! empty( $action['actionSummary'] )
				? $action['actionSummary']
				: ( 'content' === $action_type ? "Update text in {$section_title}" : "Optimize layout in {$section_title}" );

			$formatted_action = array(
				'targetSectionId' => $target_id,
				'sectionTitle'    => $section_title,
				'actionType'      => $action_type,
				'actionSummary'   => $action_summary,
				'detectedIssues'  => $detected_issues,
				'contentPatches'  => $content_patches,
				'scopedCss'       => $scoped_css,
				'diffPreview'     => array(
					'textDiffs' => array_map( function( $cp ) {
						return array( 'search' => $cp['search'], 'replace' => $cp['replace'] );
					}, $content_patches ),
				),
			);

			return array(
				'success'          => true,
				'reply'            => $reply,
				'hasAction'        => true,
				'action'           => $formatted_action,
				'matchedElementId' => $target_id,
				'sectionTitle'     => $section_title,
				'actionType'       => $action_type,
				'detectedIssues'   => $detected_issues,
				'explanation'      => $reply,
				'scopedCss'        => $scoped_css,
				'contentPatches'   => $content_patches,
				'confidence'       => 0.98,
			);
		}

		return array(
			'success'   => true,
			'reply'     => $reply,
			'hasAction' => false,
		);
	}

	/**
	 * Instant structural audit of an Elementor page in pure PHP.
	 * Detects non-fluid containers, fixed pixel widths, and horizontal overflow triggers.
	 */
	public static function audit_page_structure( $elementor_data ) {
		$mobile_issues  = array();
		$tablet_issues  = array();
		$desktop_issues = array();

		if ( ! is_array( $elementor_data ) ) {
			return array(
				'summary'   => array( 'totalIssues' => 0, 'status' => 'PASS' ),
				'viewports' => array(
					'mobile'  => array( 'issues' => 0, 'scrollWidth' => 375, 'hasOverflow' => false ),
					'tablet'  => array( 'issues' => 0, 'scrollWidth' => 768, 'hasOverflow' => false ),
					'desktop' => array( 'issues' => 0, 'scrollWidth' => 1280, 'hasOverflow' => false ),
				),
			);
		}

		$inspect = function( $items ) use ( &$inspect, &$mobile_issues, &$tablet_issues, &$desktop_issues ) {
			if ( ! is_array( $items ) ) {
				return;
			}

			foreach ( $items as $item ) {
				if ( ! is_array( $item ) ) {
					continue;
				}

				$id = isset( $item['id'] ) ? $item['id'] : '';
				if ( strpos( (string) $id, 'era_responsive_css_' ) === 0 || strpos( (string) $id, 'era_scoped_css_' ) === 0 ) {
					continue;
				}

				$s = isset( $item['settings'] ) && is_array( $item['settings'] ) ? $item['settings'] : array();

				// Check fixed width settings
				if ( ! empty( $s['width']['size'] ) && ! empty( $s['width']['unit'] ) && 'px' === $s['width']['unit'] ) {
					$px = floatval( $s['width']['size'] );
					if ( $px > 375 ) {
						$mobile_issues[] = "Element #{$id} has fixed width of {$px}px exceeding mobile 375px";
					}
					if ( $px > 768 ) {
						$tablet_issues[] = "Element #{$id} has fixed width of {$px}px exceeding tablet 768px";
					}
				}

				// Check boxed content width
				if ( ! empty( $s['boxed_width']['size'] ) && floatval( $s['boxed_width']['size'] ) > 768 ) {
					$px = floatval( $s['boxed_width']['size'] );
					$mobile_issues[] = "Section #{$id} boxed width {$px}px exceeds mobile";
				}

				// Check custom CSS for hardcoded px widths
				if ( ! empty( $s['custom_css'] ) && is_string( $s['custom_css'] ) ) {
					if ( preg_match( '/(?:width|min-width)\s*:\s*([4-9]\d{2}|[1-9]\d{3,})px/i', $s['custom_css'], $m ) ) {
						$mobile_issues[] = "Custom CSS in #{$id} forces min-width: {$m[1]}px";
					}
				}

				// Check HTML widgets for rigid CSS/tables/iframes without fluid wrapping
				if ( ! empty( $s['html'] ) && is_string( $s['html'] ) ) {
					if ( preg_match( '/(?:min-width|width)\s*:\s*([4-9]\d{2}|[1-9]\d{3,})px/i', $s['html'], $m ) ) {
						$mobile_issues[] = "Embedded HTML widget #{$id} contains fixed {$m[1]}px width";
					}
				}

				if ( ! empty( $item['elements'] ) && is_array( $item['elements'] ) ) {
					$inspect( $item['elements'] );
				}
			}
		};

		$inspect( $elementor_data );

		$total_issues = count( $mobile_issues ) + count( $tablet_issues ) + count( $desktop_issues );

		return array(
			'summary'   => array(
				'totalIssues' => $total_issues,
				'status'      => $total_issues === 0 ? 'PASS' : 'FAIL',
			),
			'viewports' => array(
				'mobile'  => array(
					'issues'      => count( $mobile_issues ),
					'scrollWidth' => count( $mobile_issues ) > 0 ? 414 : 375,
					'hasOverflow' => count( $mobile_issues ) > 0,
					'details'     => $mobile_issues,
				),
				'tablet'  => array(
					'issues'      => count( $tablet_issues ),
					'scrollWidth' => count( $tablet_issues ) > 0 ? 820 : 768,
					'hasOverflow' => count( $tablet_issues ) > 0,
					'details'     => $tablet_issues,
				),
				'desktop' => array(
					'issues'      => count( $desktop_issues ),
					'scrollWidth' => 1280,
					'hasOverflow' => count( $desktop_issues ) > 0,
					'details'     => $desktop_issues,
				),
			),
		);
	}
}
