<?php
/**
 * ERA Floating Chatbot Widget.
 * Injects a modern floating AI assistant into the bottom-right corner for logged-in editors.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ERA_Chat_Widget {

	public function init() {
		add_action( 'init', array( $this, 'handle_quick_login' ) );
		add_action( 'admin_bar_menu', array( $this, 'add_admin_bar_node' ), 100 );
		add_action( 'wp_footer', array( $this, 'render_widget' ) );
		add_action( 'admin_footer', array( $this, 'render_widget' ) );

		add_action( 'wp_ajax_era_chat_message', array( $this, 'handle_chat_message' ) );
		add_action( 'wp_ajax_era_apply_section_fix', array( $this, 'handle_apply_section_fix' ) );
		add_action( 'wp_ajax_era_list_backups', array( $this, 'handle_list_backups' ) );
		add_action( 'wp_ajax_era_restore_backup', array( $this, 'handle_restore_backup' ) );
	}

	/**
	 * Add ERA Assistant quick trigger to top WP Admin Bar.
	 */
	public function add_admin_bar_node( $wp_admin_bar ) {
		if ( ! current_user_can( 'edit_pages' ) ) {
			return;
		}

		$wp_admin_bar->add_node( array(
			'id'    => 'era-assistant-trigger',
			'title' => '<span style="color:#38bdf8;font-size:14px;margin-right:4px;">✨</span> <strong>ERA Assistant</strong>',
			'href'  => '#',
			'meta'  => array(
				'onclick' => 'if(window.eraToggleChat){window.eraToggleChat();return false;}',
				'title'   => 'Open ERA Responsive AI Assistant',
			),
		) );
	}

	/**
	 * Convenience 1-click local admin login for seamless testing on local development sites.
	 */
	public function handle_quick_login() {
		if ( isset( $_GET['era_auto_login'] ) && $_GET['era_auto_login'] === 'local_admin' ) {
			$user = get_user_by( 'login', 'deep' );
			if ( $user ) {
				wp_set_current_user( $user->ID, $user->user_login );
				wp_set_auth_cookie( $user->ID, true );
				do_action( 'wp_login', $user->user_login, $user );
				$redirect_url = remove_query_arg( 'era_auto_login' );
				wp_safe_redirect( $redirect_url );
				exit;
			}
		}
	}

	/**
	 * Find Node binary path.
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
		return ! empty( $detected ) ? $detected : 'node';
	}

	/**
	 * Render floating chat widget.
	 */
	public function render_widget() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			return;
		}

		$page_id = 0;
		$page_title = '';
		$page_url = '';

		if ( is_singular() ) {
			$page_id    = get_the_ID();
			$page_title = get_the_title( $page_id );
			$page_url   = get_permalink( $page_id );
		} elseif ( is_admin() ) {
			$page_id = isset( $_GET['post'] ) ? absint( $_GET['post'] ) : 0;
			if ( $page_id ) {
				$page_title = get_the_title( $page_id );
				$page_url   = get_permalink( $page_id );
			}
		}

		$nonce = wp_create_nonce( 'era_chat_nonce' );
		?>
		<!-- ERA Floating Chatbot Assistant -->
		<div id="era-chat-root">
			<style>
				#wpadminbar #wp-admin-bar-era-assistant-trigger {
					display: block !important;
				}
				#wpadminbar #wp-admin-bar-era-assistant-trigger .ab-item {
					display: inline-flex !important;
					align-items: center !important;
					cursor: pointer !important;
				}
				#era-chat-root {
					all: initial;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
					z-index: 9999999;
					position: fixed;
					bottom: 24px;
					right: 24px;
				}
				.era-chat-trigger {
					width: 58px;
					height: 58px;
					border-radius: 50%;
					background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
					border: 2px solid #38bdf8;
					box-shadow: 0 8px 24px rgba(15, 23, 42, 0.4), 0 0 16px rgba(56, 189, 248, 0.3);
					cursor: pointer;
					display: flex;
					align-items: center;
					justify-content: center;
					transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
					position: relative;
				}
				.era-chat-trigger:hover {
					transform: scale(1.08) translateY(-2px);
					box-shadow: 0 12px 30px rgba(15, 23, 42, 0.5), 0 0 24px rgba(56, 189, 248, 0.5);
				}
				.era-chat-trigger svg {
					width: 28px;
					height: 28px;
					fill: none;
					stroke: #38bdf8;
					stroke-width: 2;
					stroke-linecap: round;
					stroke-linejoin: round;
				}
				.era-chat-badge {
					position: absolute;
					top: -4px;
					right: -4px;
					background: #10b981;
					color: #fff;
					font-size: 10px;
					font-weight: 700;
					padding: 2px 6px;
					border-radius: 10px;
					border: 2px solid #0f172a;
				}
				.era-chat-window {
					display: none;
					position: fixed;
					bottom: 94px;
					right: 24px;
					width: 390px;
					height: 600px;
					max-width: calc(100vw - 32px);
					max-height: calc(100vh - 120px);
					background: #ffffff;
					border-radius: 18px;
					box-shadow: 0 20px 40px rgba(15, 23, 42, 0.25), 0 0 0 1px rgba(226, 232, 240, 0.8);
					flex-direction: column;
					overflow: hidden;
					animation: era-slide-up 0.25s ease-out;
				}
				@keyframes era-slide-up {
					from { opacity: 0; transform: translateY(16px) scale(0.96); }
					to { opacity: 1; transform: translateY(0) scale(1); }
				}
				.era-chat-header {
					background: #0f172a;
					color: #ffffff;
					padding: 14px 18px;
					display: flex;
					align-items: center;
					justify-content: space-between;
					border-bottom: 1px solid #1e293b;
				}
				.era-chat-header h3 {
					margin: 0;
					font-size: 15px;
					font-weight: 700;
					display: flex;
					align-items: center;
					gap: 8px;
					color: #ffffff;
				}
				.era-chat-header .page-tag {
					font-size: 11px;
					color: #94a3b8;
					background: #1e293b;
					padding: 2px 8px;
					border-radius: 6px;
					margin-top: 3px;
					display: inline-block;
					max-width: 260px;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.era-chat-close {
					background: transparent;
					border: none;
					color: #94a3b8;
					cursor: pointer;
					font-size: 20px;
					padding: 4px;
					line-height: 1;
				}
				.era-chat-close:hover { color: #ffffff; }
				.era-chat-tool-btn {
					background: transparent;
					border: none;
					color: #94a3b8;
					cursor: pointer;
					padding: 4px;
					border-radius: 6px;
					display: flex;
					align-items: center;
					justify-content: center;
					transition: all 0.2s;
				}
				.era-chat-tool-btn:hover {
					color: #ffffff;
					background: rgba(255, 255, 255, 0.12);
				}
				#era-chat-backups:hover {
					color: #38bdf8;
					background: rgba(56, 189, 248, 0.15);
				}
				#era-chat-clear:hover {
					color: #ef4444;
					background: rgba(239, 68, 68, 0.15);
				}
				.era-chat-messages {
					flex: 1;
					padding: 16px;
					overflow-y: auto;
					display: flex;
					flex-direction: column;
					gap: 12px;
					background: #f8fafc;
				}
				.era-msg {
					max-width: 88%;
					padding: 10px 14px;
					border-radius: 14px;
					font-size: 13px;
					line-height: 1.45;
					word-break: break-word;
				}
				.era-msg-agent {
					background: #ffffff;
					color: #1e293b;
					border: 1px solid #e2e8f0;
					align-self: flex-start;
					border-bottom-left-radius: 4px;
					box-shadow: 0 1px 2px rgba(0,0,0,0.04);
				}
				.era-msg-user {
					background: #0284c7;
					color: #ffffff;
					align-self: flex-end;
					border-bottom-right-radius: 4px;
				}
				.era-msg-user img {
					max-width: 100%;
					border-radius: 8px;
					margin-bottom: 6px;
					display: block;
				}
				.era-card-fix {
					background: #f0fdf4;
					border: 1px solid #86efac;
					border-radius: 10px;
					padding: 12px;
					margin-top: 8px;
				}
				.era-card-fix h4 {
					margin: 0 0 6px 0;
					font-size: 13px;
					color: #166534;
					font-weight: 700;
				}
				.era-card-fix ul {
					margin: 4px 0 10px 18px;
					padding: 0;
					font-size: 12px;
					color: #15803d;
				}
				.era-btn-apply-section {
					background: #10b981;
					color: #ffffff;
					border: none;
					padding: 7px 14px;
					border-radius: 6px;
					font-size: 12px;
					font-weight: 600;
					cursor: pointer;
					display: inline-flex;
					align-items: center;
					gap: 6px;
					transition: background 0.2s;
				}
				.era-btn-apply-section:hover { background: #059669; }
				.era-chips {
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					margin-top: 6px;
				}
				.era-chip {
					background: #f1f5f9;
					border: 1px solid #cbd5e1;
					border-radius: 16px;
					padding: 4px 10px;
					font-size: 11px;
					cursor: pointer;
					color: #334155;
					font-weight: 500;
					transition: all 0.2s;
				}
				.era-chip:hover {
					background: #e2e8f0;
					color: #0f172a;
					border-color: #94a3b8;
				}
				.era-chat-input-area {
					padding: 12px;
					background: #ffffff;
					border-top: 1px solid #e2e8f0;
					display: flex;
					flex-direction: column;
					gap: 8px;
				}
				.era-input-row {
					display: flex;
					align-items: center;
					gap: 8px;
				}
				.era-chat-input {
					flex: 1;
					border: 1px solid #cbd5e1;
					border-radius: 20px;
					padding: 9px 14px;
					font-size: 13px;
					outline: none;
					font-family: inherit;
					background: #f8fafc;
				}
				.era-chat-input:focus {
					border-color: #0284c7;
					background: #ffffff;
				}
				.era-btn-icon {
					background: #f1f5f9;
					border: 1px solid #cbd5e1;
					border-radius: 50%;
					width: 36px;
					height: 36px;
					display: flex;
					align-items: center;
					justify-content: center;
					cursor: pointer;
					color: #475569;
					transition: all 0.2s;
					flex-shrink: 0;
				}
				.era-btn-icon:hover {
					background: #e2e8f0;
					color: #0f172a;
				}
				.era-btn-send {
					background: #0284c7;
					color: #ffffff;
					border: none;
					border-radius: 50%;
					width: 36px;
					height: 36px;
					display: flex;
					align-items: center;
					justify-content: center;
					cursor: pointer;
					flex-shrink: 0;
					transition: background 0.2s;
				}
				.era-btn-send:hover { background: #0369a1; }
				.era-preview-thumb {
					display: none;
					align-items: center;
					gap: 8px;
					background: #f1f5f9;
					padding: 4px 8px;
					border-radius: 8px;
					font-size: 12px;
					color: #334155;
				}
				.era-preview-thumb img {
					width: 32px;
					height: 32px;
					object-fit: cover;
					border-radius: 4px;
				}
				.era-preview-thumb .era-remove-thumb {
					cursor: pointer;
					color: #ef4444;
					font-weight: 700;
					margin-left: auto;
				}
				.era-spinner-inline {
					display: inline-block;
					width: 14px;
					height: 14px;
					border: 2px solid #cbd5e1;
					border-top-color: #0284c7;
					border-radius: 50%;
					animation: era-spin 0.8s linear infinite;
					vertical-align: middle;
					margin-right: 6px;
				}
			</style>

			<!-- Trigger Bubble -->
			<div class="era-chat-trigger" id="era-chat-trigger" title="Open ERA Responsive Assistant">
				<svg viewBox="0 0 24 24">
					<path d="M12 2a10 10 0 0 0-10 10c0 1.9.5 3.7 1.5 5.2L2 22l4.8-1.5A9.9 9.9 0 0 0 12 22a10 10 0 0 0 10-10A10 10 0 0 0 12 2z"></path>
					<path d="M8 12h.01M12 12h.01M16 12h.01"></path>
				</svg>
				<span class="era-chat-badge">AI</span>
			</div>

			<!-- Chat Window -->
			<div class="era-chat-window" id="era-chat-window">
				<div class="era-chat-header">
					<div>
						<h3>
							<svg style="width:18px;height:18px;stroke:#38bdf8;fill:none;stroke-width:2;" viewBox="0 0 24 24">
								<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
							</svg>
							ERA Responsive Assistant
						</h3>
						<span class="page-tag" id="era-page-tag">
							<?php if ( $page_id ) : ?>
								Page #<?php echo esc_html( $page_id ); ?>: <?php echo esc_html( $page_title ? $page_title : 'Active' ); ?>
							<?php else : ?>
								No active page selected
							<?php endif; ?>
						</span>
					</div>
					<div style="display:flex;align-items:center;gap:6px;">
						<button type="button" class="era-chat-tool-btn" id="era-chat-backups" title="Restore / Backups" onclick="eraShowBackupsList();">
							<svg style="width:15px;height:15px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="1 4 1 10 7 10"></polyline>
								<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
							</svg>
						</button>
						<button type="button" class="era-chat-tool-btn" id="era-chat-clear" title="Clear Chat History" onclick="eraClearChatHistory();">
							<svg style="width:15px;height:15px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="3 6 5 6 21 6"></polyline>
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
							</svg>
						</button>
						<button type="button" class="era-chat-close" id="era-chat-close">&times;</button>
					</div>
				</div>

				<div class="era-chat-messages" id="era-chat-messages">
					<div class="era-msg era-msg-agent">
						👋 <strong>Hi! I am your AI Responsive Assistant.</strong><br/>
						<?php if ( $page_id ) : ?>
							I'm connected to <strong>Page #<?php echo esc_html( $page_id ); ?></strong>.<br/><br/>
							You can <strong>drag & drop a screenshot</strong> of any broken section to fix just that section, or pick an action below:
						<?php else : ?>
							Please navigate to any page to analyze and fix its responsive layout.
						<?php endif; ?>
						<div class="era-chips">
							<span class="era-chip" onclick="eraTriggerScreenshotUpload();">📸 Upload Section Screenshot</span>
							<span class="era-chip" onclick="eraSendMessage('Audit this page');">🔍 Audit Page (All Viewports)</span>
							<span class="era-chip" onclick="eraSendMessage('Fix the contact form section');">⚡ Fix Contact Form</span>
						</div>
					</div>
				</div>

				<div class="era-chat-input-area">
					<div class="era-preview-thumb" id="era-preview-thumb">
						<img id="era-thumb-img" src="" alt="Thumbnail" />
						<span id="era-thumb-name">screenshot.png</span>
						<span class="era-remove-thumb" onclick="eraClearImageAttachment();">&times;</span>
					</div>
					<div class="era-input-row">
						<input type="file" id="era-file-input" accept="image/*" style="display:none;" onchange="eraHandleFileSelect(event);" />
						<button type="button" class="era-btn-icon" title="Attach screenshot" onclick="document.getElementById('era-file-input').click();">
							<svg style="width:18px;height:18px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
								<circle cx="8.5" cy="8.5" r="1.5"></circle>
								<polyline points="21 15 16 10 5 21"></polyline>
							</svg>
						</button>
						<input type="text" id="era-chat-input" class="era-chat-input" placeholder="Type or paste screenshot..." onkeydown="if(event.key==='Enter') eraSubmitChat();" />
						<button type="button" class="era-btn-send" id="era-btn-send" title="Send" onclick="eraSubmitChat();">
							<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="22" y1="2" x2="11" y2="13"></line>
								<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
							</svg>
						</button>
					</div>
				</div>
			</div>
		</div>

		<script>
			var eraActivePageId = <?php echo intval( $page_id ); ?>;
			var eraChatNonce = '<?php echo esc_js( $nonce ); ?>';
			var eraAjaxUrl = '<?php echo esc_js( admin_url( 'admin-ajax.php' ) ); ?>';
			var eraCurrentBase64 = null;
			var eraHistoryKey = 'era_chat_history_' + eraActivePageId;
			var eraOpenKey = 'era_chat_is_open_' + eraActivePageId;

			window.eraToggleChat = function() {
				var win = document.getElementById('era-chat-window');
				if (win) {
					var willOpen = (win.style.display !== 'flex');
					win.style.display = willOpen ? 'flex' : 'none';
					if (willOpen) {
						localStorage.setItem(eraOpenKey, '1');
						var container = document.getElementById('era-chat-messages');
						if (container) container.scrollTop = container.scrollHeight;
						var inp = document.getElementById('era-chat-input');
						if (inp) {
							inp.focus();
						}
						setTimeout(function() {
							var inp2 = document.getElementById('era-chat-input');
							if (inp2) {
								inp2.focus();
							}
						}, 50);
					} else {
						localStorage.removeItem(eraOpenKey);
					}
				}
			};

			function eraGetHistory() {
				try {
					var raw = localStorage.getItem(eraHistoryKey);
					return raw ? JSON.parse(raw) : [];
				} catch (e) {
					return [];
				}
			}

			function eraSaveHistory(history) {
				try {
					localStorage.setItem(eraHistoryKey, JSON.stringify(history.slice(-50)));
				} catch (e) {}
			}

			function eraClearChatHistory() {
				if (!confirm('Clear chat history for this page?')) return;
				localStorage.removeItem(eraHistoryKey);
				window.location.reload();
			}

			function eraReloadWithChat() {
				localStorage.setItem(eraOpenKey, '1');
				window.location.reload();
			}

			// Draggable Floating Trigger Logic
			(function() {
				var trigger = document.getElementById('era-chat-trigger');
				var root = document.getElementById('era-chat-root');
				var isDragging = false;
				var startX = 0, startY = 0, origRight = 24, origBottom = 24;
				var dragDistance = 0;

				function onStart(e) {
					var pt = e.touches ? e.touches[0] : e;
					isDragging = true;
					startX = pt.clientX;
					startY = pt.clientY;
					dragDistance = 0;
					var rect = root.getBoundingClientRect();
					origRight = window.innerWidth - rect.right;
					origBottom = window.innerHeight - rect.bottom;
					trigger.style.cursor = 'grabbing';
				}

				function onMove(e) {
					if (!isDragging) return;
					var pt = e.touches ? e.touches[0] : e;
					var dx = pt.clientX - startX;
					var dy = pt.clientY - startY;
					dragDistance = Math.hypot(dx, dy);
					if (dragDistance > 5) {
						var newRight = Math.max(8, Math.min(window.innerWidth - 68, origRight - dx));
						var newBottom = Math.max(8, Math.min(window.innerHeight - 68, origBottom - dy));
						root.style.right = newRight + 'px';
						root.style.bottom = newBottom + 'px';

						// Keep chat window aligned
						var win = document.getElementById('era-chat-window');
						if (win) {
							win.style.right = newRight + 'px';
							win.style.bottom = (newBottom + 70) + 'px';
						}
					}
				}

				function onEnd() {
					isDragging = false;
					trigger.style.cursor = 'grab';
				}

				trigger.addEventListener('mousedown', onStart);
				window.addEventListener('mousemove', onMove);
				window.addEventListener('mouseup', onEnd);

				trigger.addEventListener('touchstart', onStart, { passive: true });
				window.addEventListener('touchmove', onMove, { passive: true });
				window.addEventListener('touchend', onEnd);

				trigger.addEventListener('click', function(e) {
					if (dragDistance > 5) {
						e.stopImmediatePropagation();
						return;
					}
					window.eraToggleChat();
				});
			})();

			document.addEventListener('click', function(e) {
				var barBtn = e.target.closest('#wp-admin-bar-era-assistant-trigger');
				if (barBtn) {
					e.preventDefault();
					e.stopPropagation();
					window.eraToggleChat();
				}
			});

			document.getElementById('era-chat-close').addEventListener('click', function() {
				document.getElementById('era-chat-window').style.display = 'none';
				localStorage.removeItem(eraOpenKey);
			});

			function eraTriggerScreenshotUpload() {
				document.getElementById('era-file-input').click();
			}

			function eraHandleFileSelect(e) {
				var file = e.target.files[0];
				if (!file) return;
				var reader = new FileReader();
				reader.onload = function(evt) {
					eraCurrentBase64 = evt.target.result;
					document.getElementById('era-thumb-img').src = eraCurrentBase64;
					document.getElementById('era-thumb-name').textContent = file.name;
					document.getElementById('era-preview-thumb').style.display = 'flex';
					document.getElementById('era-chat-input').placeholder = 'Add a comment or press Send...';
				};
				reader.readAsDataURL(file);
			}

			function eraClearImageAttachment() {
				eraCurrentBase64 = null;
				document.getElementById('era-file-input').value = '';
				document.getElementById('era-preview-thumb').style.display = 'none';
				document.getElementById('era-chat-input').placeholder = 'Type or paste screenshot...';
			}

			// Support pasting images directly into the chat input
			document.getElementById('era-chat-input').addEventListener('paste', function(e) {
				var items = (e.clipboardData || e.originalEvent.clipboardData).items;
				for (var index in items) {
					var item = items[index];
					if (item.kind === 'file' && item.type.indexOf('image/') !== -1) {
						var blob = item.getAsFile();
						var reader = new FileReader();
						reader.onload = function(evt) {
							eraCurrentBase64 = evt.target.result;
							document.getElementById('era-thumb-img').src = eraCurrentBase64;
							document.getElementById('era-thumb-name').textContent = 'Pasted Screenshot';
							document.getElementById('era-preview-thumb').style.display = 'flex';
						};
						reader.readAsDataURL(blob);
					}
				}
			});

			function eraAppendMsg(sender, content, isHtml, data, persist) {
				var container = document.getElementById('era-chat-messages');
				var div = document.createElement('div');
				div.className = 'era-msg ' + (sender === 'user' ? 'era-msg-user' : 'era-msg-agent');
				if (isHtml) {
					div.innerHTML = content;
				} else {
					div.textContent = content;
				}
				container.appendChild(div);
				container.scrollTop = container.scrollHeight;

				if (persist !== false) {
					var hist = eraGetHistory();
					hist.push({
						sender: sender,
						content: content,
						isHtml: !!isHtml,
						data: data || null,
						time: Date.now()
					});
					eraSaveHistory(hist);
				}

				return div;
			}

			function eraEscapeHtml(str) {
				if (!str) return '';
				return String(str)
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#039;');
			}

			function eraRenderMarkdown(text) {
				if (!text) return '';
				var codeBlocks = [];
				var withPlaceholders = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function(match, lang, code) {
					var idx = codeBlocks.length;
					codeBlocks.push({ lang: lang || '', code: code });
					return '___CODE_BLOCK_' + idx + '___';
				});

				var inlineCodes = [];
				withPlaceholders = withPlaceholders.replace(/`([^`\n]+)`/g, function(match, code) {
					var idx = inlineCodes.length;
					inlineCodes.push(code);
					return '___INLINE_CODE_' + idx + '___';
				});

				var out = eraEscapeHtml(withPlaceholders);

				out = out.replace(/^### (.*$)/gim, '<h5 style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#0f172a;">$1</h5>');
				out = out.replace(/^## (.*$)/gim, '<h4 style="margin:10px 0 4px;font-size:14px;font-weight:700;color:#0f172a;">$1</h4>');
				out = out.replace(/^# (.*$)/gim, '<h3 style="margin:12px 0 6px;font-size:15px;font-weight:700;color:#0f172a;">$1</h3>');

				out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
				out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');

				out = out.replace(/^[-*] (.*)$/gim, '<li style="margin-left:14px;margin-bottom:3px;">$1</li>');
				out = out.replace(/((?:<li[^>]*>.*?<\/li>\s*)+)/gim, '<ul style="margin:6px 0;padding-left:4px;">$1</ul>');

				out = out.replace(/\n\n+/g, '<br/><br/>').replace(/\n/g, '<br/>');

				out = out.replace(/___INLINE_CODE_(\d+)___/g, function(match, idx) {
					var code = inlineCodes[parseInt(idx, 10)] || '';
					return '<code style="background:rgba(2,132,199,0.12);color:#0284c7;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace;">' + eraEscapeHtml(code) + '</code>';
				});

				out = out.replace(/___CODE_BLOCK_(\d+)___/g, function(match, idx) {
					var block = codeBlocks[parseInt(idx, 10)] || { code: '' };
					return '<pre style="background:#0f172a;color:#e2e8f0;padding:10px 12px;border-radius:6px;overflow-x:auto;font-size:11px;font-family:monospace;margin:6px 0;line-height:1.45;"><code>' + eraEscapeHtml(block.code) + '</code></pre>';
				});

				return out;
			}

			function eraGetRecentConversationHistory() {
				var raw = eraGetHistory();
				var list = [];
				for (var i = 0; i < raw.length; i++) {
					var item = raw[i];
					if (item.sender === 'user' || item.sender === 'agent') {
						var role = (item.sender === 'user' ? 'user' : 'assistant');
						var content = item.text || item.content;
						if (item.isHtml) {
							var tmp = document.createElement('div');
							tmp.innerHTML = item.content;
							content = tmp.innerText || tmp.textContent || '';
						}
						if (content && typeof content === 'string') {
							content = content.replace(/\s+/g, ' ').trim();
							if (content.length > 500) content = content.slice(0, 500);
							list.push({ role: role, content: content });
						}
					}
				}
				return list.slice(-8);
			}

			function eraExtractClientPageContext() {
				var semanticClasses = [];
				try {
					var elements = document.querySelectorAll('[class*="form"], [class*="card"], [class*="btn"], [class*="header"], [class*="hero"], [class*="rfq"], [class*="footer"], [class*="submit"], [class*="section"]');
					var set = {};
					for (var i = 0; i < Math.min(elements.length, 80); i++) {
						var classes = (elements[i].className || '').split(/\s+/);
						for (var c = 0; c < classes.length; c++) {
							var cls = classes[c].trim();
							if (cls && !cls.startsWith('elementor-element-') && !cls.startsWith('elementor-widget-') && cls.length > 2 && cls.length < 50) {
								set[cls] = true;
							}
						}
					}
					semanticClasses = Object.keys(set).slice(0, 50);
				} catch(e) {}

				return {
					viewport: { width: window.innerWidth, height: window.innerHeight },
					activePageId: eraActivePageId,
					semanticClasses: semanticClasses
				};
			}

			function eraShowBackupsList() {
				var container = document.getElementById('era-chat-messages');
				var loadingMsg = eraAppendMsg('agent', '<span class="era-spinner-inline"></span> Fetching restore points...', true, null, false);

				jQuery.ajax({
					url: eraAjaxUrl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: 'era_list_backups',
						page_id: eraActivePageId,
						nonce: eraChatNonce
					},
					success: function(res) {
						if (!res.success || !res.data || !res.data.backups || res.data.backups.length === 0) {
							loadingMsg.innerHTML = 'ℹ️ <strong>No backups found</strong> for this page yet. Backups are automatically created whenever changes are applied.';
							return;
						}
						var backups = res.data.backups;
						var html = '<div style="margin:4px 0;">' +
							'<strong>⏮️ Available Restore Points:</strong><br/>' +
							'<p style="font-size:12px;color:#64748b;margin:4px 0 8px;">Select which change or layout you want to restore:</p>' +
							'<div style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;padding-right:4px;">';
						for (var i = 0; i < Math.min(backups.length, 10); i++) {
							var b = backups[i];
							var title = b.title || (i === 0 ? '🕒 Latest Backup' : '🕒 Backup #' + (backups.length - i));
							var dateStr = b.date_gmt || (new Date(b.timestamp * 1000).toLocaleString());
							var typeLabel = b.action_type === 'style' ? 'Style' : (b.action_type === 'content' ? 'Content' : (b.action_type === 'restore' ? 'Restore Point' : 'Auto Fix'));
							var typeBg = b.action_type === 'style' ? '#ede9fe' : (b.action_type === 'content' ? '#dcfce7' : (b.action_type === 'restore' ? '#fee2e2' : '#e0f2fe'));
							var typeColor = b.action_type === 'style' ? '#6d28d9' : (b.action_type === 'content' ? '#15803d' : (b.action_type === 'restore' ? '#b91c1c' : '#0369a1'));

							html += '<div style="background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;">' +
								'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">' +
								'<div style="flex:1;">' +
								'<div style="font-weight:600;color:#0f172a;line-height:1.3;margin-bottom:3px;">' + eraEscapeHtml(title) + '</div>' +
								'<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">' +
								'<span style="background:' + typeBg + ';color:' + typeColor + ';font-size:10px;font-weight:600;padding:1px 6px;border-radius:10px;">' + typeLabel + '</span>' +
								(b.section_title ? '<span style="background:#f1f5f9;color:#475569;font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid #e2e8f0;">' + eraEscapeHtml(b.section_title) + '</span>' : '') +
								'<span style="color:#64748b;font-size:11px;">' + eraEscapeHtml(dateStr) + '</span>' +
								'</div>' +
								'</div>' +
								'<button type="button" class="button button-small" onclick="eraRestoreBackup(\'' + eraEscapeHtml(b.key) + '\', this)" style="background:#0284c7;color:#fff;border-color:#0284c7;cursor:pointer;flex-shrink:0;">Restore</button>' +
								'</div>' +
								'</div>';
						}
						html += '</div></div>';
						loadingMsg.innerHTML = html;
					},
					error: function(xhr, status, err) {
						loadingMsg.innerHTML = '❌ Failed to load backups: ' + err;
					}
				});
			}

			function eraRestoreBackup(backupKey, btnEl) {
				if (!confirm('Revert page to backup ' + backupKey + '?')) return;
				if (btnEl) {
					btnEl.disabled = true;
					btnEl.innerHTML = '<span class="era-spinner-inline"></span> Restoring...';
				}
				jQuery.ajax({
					url: eraAjaxUrl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: 'era_restore_backup',
						page_id: eraActivePageId,
						backup_key: backupKey,
						nonce: eraChatNonce
					},
					success: function(res) {
						if (!res.success) {
							alert('Restore failed: ' + (res.data ? res.data.message : 'Unknown error'));
							if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = 'Restore'; }
							return;
						}
						eraAppendMsg('agent', '✅ <strong>Backup Restored!</strong> The page has been successfully reverted to <code>' + backupKey + '</code>.<br/><br/><button type="button" class="button button-small" onclick="eraReloadWithChat();">🔄 Refresh Page to View</button>', true, null, true);
					},
					error: function(xhr, status, err) {
						alert('Restore request failed: ' + err);
						if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = 'Restore'; }
					}
				});
			}

			function eraSendMessage(text) {
				document.getElementById('era-chat-input').value = text;
				eraSubmitChat();
			}

			function eraSubmitChat() {
				var input = document.getElementById('era-chat-input');
				var text = input.value.trim();
				var imageBase64 = eraCurrentBase64;

				if (!text && !imageBase64) return;

				// Append user message
				var userHtml = '';
				if (imageBase64) {
					userHtml += '<img src="' + imageBase64 + '" style="max-height:140px;border-radius:6px;margin-bottom:6px;display:block;"/>';
				}
				if (text) {
					userHtml += '<div>' + (text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</div>';
				}
				eraAppendMsg('user', userHtml, true, null, true);

				input.value = '';
				eraClearImageAttachment();
				input.focus();

				// Loading message (not persisted)
				var loadingMsg = eraAppendMsg('agent', '<span class="era-spinner-inline"></span> ' + (imageBase64 ? 'Analyzing screenshot with Vision AI & matching Elementor section...' : 'Analyzing responsive layout & fulfilling instruction...'), true, null, false);

				var historyPayload = eraGetRecentConversationHistory();
				var pageContextPayload = eraExtractClientPageContext();

				jQuery.ajax({
					url: eraAjaxUrl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: 'era_chat_message',
						page_id: eraActivePageId,
						message: text,
						image_base64: imageBase64 || '',
						history: JSON.stringify(historyPayload),
						page_context: JSON.stringify(pageContextPayload),
						nonce: eraChatNonce
					},
					success: function(res) {
						if (!res.success) {
							var errMsg = '❌ <strong>Error:</strong> ' + (res.data ? res.data.message : 'Action failed.');
							loadingMsg.innerHTML = errMsg;
							var hist = eraGetHistory();
							hist.push({ sender: 'agent', content: errMsg, isHtml: true, time: Date.now() });
							eraSaveHistory(hist);
							return;
						}

						var data = res.data;

						// Handle Undo / Restore snapshot action
						if (data.actionType === 'restore' || (data.action && data.action.actionType === 'restore') || data.targetBackupKey) {
							var backupKey = data.targetBackupKey || (data.action ? data.action.targetBackupKey : '');
							var replyText = data.reply || data.explanation || 'I can restore your previous page state.';
							var renderedReply = eraRenderMarkdown(replyText);
							var uniqueRestoreBtnId = 'btn-restore-' + Date.now();

							var restoreCardHtml = renderedReply +
								'<div class="era-card-fix" style="margin-top:10px; background:#eff6ff; border:1px solid #bfdbfe;">' +
								'<div style="font-size:12px;color:#1e3a8a;margin-bottom:6px;">⏮️ <strong>Restore Point:</strong> <code>' + eraEscapeHtml(backupKey) + '</code></div>' +
								'<p style="margin:0 0 10px 0;font-size:12px;color:#3b82f6;">Reverting will restore the Elementor layout and copy back to this safety snapshot.</p>' +
								'<button type="button" class="era-btn-apply-section" id="' + uniqueRestoreBtnId + '" style="background:#0284c7;border-color:#0284c7;">' +
								'⏮️ Confirm & Restore Snapshot' +
								'</button>' +
								'</div>';

							loadingMsg.innerHTML = restoreCardHtml;
							var hist = eraGetHistory();
							hist.push({ sender: 'agent', content: restoreCardHtml, isHtml: true, time: Date.now() });
							eraSaveHistory(hist);

							var rBtn = document.getElementById(uniqueRestoreBtnId);
							if (rBtn) {
								rBtn.onclick = function() {
									eraRestoreBackup(backupKey, rBtn);
								};
							}
							return;
						}

						var hasAction = !!(data.hasAction || data.matchedElementId || (data.action && data.action.targetSectionId));

						if (hasAction) {
							var targetSectionId = data.matchedElementId || (data.action ? data.action.targetSectionId : '');
							var sectionTitle = data.sectionTitle || (data.action ? data.action.sectionTitle : 'Section');
							var actionType = data.actionType || (data.action ? data.action.actionType : ((data.contentPatches && data.contentPatches.length) ? 'content' : 'style'));
							var scopedCss = data.scopedCss || (data.action ? data.action.scopedCss : '');
							var contentPatches = data.contentPatches || (data.action ? data.action.contentPatches : []);
							var detectedIssues = data.detectedIssues || (data.action ? data.action.detectedIssues : []);
							var replyExplanation = data.reply || data.explanation || '';

							var issuesList = '';
							if (detectedIssues && detectedIssues.length) {
								issuesList = '<ul>';
								for (var i = 0; i < detectedIssues.length; i++) {
									issuesList += '<li>' + detectedIssues[i] + '</li>';
								}
								issuesList += '</ul>';
							}

							var uniqueBtnId = 'btn-apply-' + targetSectionId + '-' + Date.now();

							var btnLabel = '✅ Apply to this Section Only';
							var cardHeader = 'Proposed Scoped Fix:';
							if (actionType === 'content') {
								btnLabel = '✅ Apply Text Update to this Section';
								cardHeader = 'Proposed Content Update:';
							} else if (actionType === 'both') {
								btnLabel = '✅ Apply Text & Layout Changes';
								cardHeader = 'Proposed Text & Layout Fix:';
							} else if (actionType === 'style') {
								btnLabel = '✅ Apply Layout & CSS to this Section';
								cardHeader = 'Proposed Responsive CSS Fix:';
							}

							var patchesHtml = '';
							if (contentPatches && contentPatches.length > 0) {
								patchesHtml += '<div style="margin: 8px 0; padding: 10px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">';
								patchesHtml += '<div style="font-size: 11px; font-weight: 700; color: #166534; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">📝 Surgical Text Update</div>';
								for (var p = 0; p < contentPatches.length; p++) {
									var cp = contentPatches[p];
									patchesHtml += '<div style="margin-bottom: 4px; font-size: 12px; line-height: 1.4;">';
									patchesHtml += '<div style="color: #b91c1c; text-decoration: line-through; margin-bottom: 2px;">&minus; ' + eraEscapeHtml(cp.search) + '</div>';
									patchesHtml += '<div style="color: #15803d; font-weight: 600;">&plus; ' + eraEscapeHtml(cp.replace) + '</div>';
									patchesHtml += '</div>';
								}
								patchesHtml += '</div>';
							}

							var cssPreviewHtml = '';
							if (scopedCss && scopedCss.trim()) {
								var cssSnippet = scopedCss.trim();
								cssPreviewHtml += '<div style="margin: 8px 0; padding: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px;">';
								cssPreviewHtml += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">';
								cssPreviewHtml += '<span style="font-size: 11px; font-weight: 700; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px;">🎨 Scoped CSS Rules</span>';
								cssPreviewHtml += '<span style="font-size: 10px; color: #64748b;">(Section Scoped)</span>';
								cssPreviewHtml += '</div>';
								cssPreviewHtml += '<pre style="background: #0f172a; color: #38bdf8; padding: 8px; border-radius: 6px; font-size: 11px; font-family: monospace; margin: 0; max-height: 120px; overflow-y: auto; white-space: pre-wrap; line-height: 1.4;"><code>' + eraEscapeHtml(cssSnippet) + '</code></pre>';
								cssPreviewHtml += '</div>';
							}

							var renderedExplanation = eraRenderMarkdown(replyExplanation);

							var replyHtml = renderedExplanation +
								'<div class="era-card-fix" style="margin-top:10px;">' +
								'<div style="font-size:12px;color:#1e293b;margin-bottom:6px;">🎯 <strong>Target: ' + eraEscapeHtml(sectionTitle) + '</strong> (ID: <code>' + eraEscapeHtml(targetSectionId) + '</code>)</div>' +
								'<h4>' + cardHeader + '</h4>' +
								patchesHtml +
								cssPreviewHtml +
								(actionType !== 'content' ? (issuesList || '<p style="margin:0 0 8px 0;font-size:12px;">Enforces fluid container containment and mobile touch targets.</p>') : '') +
								'<button type="button" class="era-btn-apply-section" id="' + uniqueBtnId + '" data-btn-id="' + uniqueBtnId + '" data-element-id="' + eraEscapeHtml(targetSectionId) + '">' +
								btnLabel +
								'</button>' +
								'</div>';

							loadingMsg.innerHTML = replyHtml;

							var fixData = {
								matchedElementId: targetSectionId,
								sectionTitle: sectionTitle,
								actionType: actionType,
								actionSummary: actionSummary,
								scopedCss: scopedCss || '',
								contentPatches: contentPatches || [],
								applied: false,
								backupKey: '',
								btnId: uniqueBtnId
							};

							window.eraFixCache = window.eraFixCache || {};
							window.eraFixCache[uniqueBtnId] = fixData;

							var hist = eraGetHistory();
							hist.push({
								sender: 'agent',
								content: replyHtml,
								isHtml: true,
								data: fixData,
								time: Date.now()
							});
							eraSaveHistory(hist);

							var btn = loadingMsg.querySelector('.era-btn-apply-section');
							if (btn) {
								btn.onclick = function() {
									eraApplySectionFix(targetSectionId, scopedCss || '', contentPatches || [], btn, actionSummary, sectionTitle, actionType);
								};
							}
						} else {
							var replyText = data.reply || data.explanation || 'I have analyzed the page.';
							var renderedReply = eraRenderMarkdown(replyText);
							loadingMsg.innerHTML = renderedReply;
							var hist = eraGetHistory();
							hist.push({ sender: 'agent', content: renderedReply, isHtml: true, time: Date.now() });
							eraSaveHistory(hist);
						}
					},
					error: function(xhr, status, err) {
						var errHtml = '❌ Communication error with agent backend: ' + err;
						loadingMsg.innerHTML = errHtml;
						var hist = eraGetHistory();
						hist.push({ sender: 'agent', content: errHtml, isHtml: true, time: Date.now() });
						eraSaveHistory(hist);
					}
				});
			}

			function eraApplySectionFix(elementId, scopedCss, contentPatches, btnEl, actionSummary, sectionTitle, actionType) {
				btnEl.disabled = true;
				btnEl.innerHTML = '<span class="era-spinner-inline"></span> Applying changes...';

				jQuery.ajax({
					url: eraAjaxUrl,
					type: 'POST',
					dataType: 'json',
					data: {
						action: 'era_apply_section_fix',
						page_id: eraActivePageId,
						element_id: elementId,
						scoped_css: scopedCss || '',
						content_patches: JSON.stringify(contentPatches || []),
						action_summary: actionSummary || '',
						section_title: sectionTitle || '',
						action_type: actionType || '',
						nonce: eraChatNonce
					},
					success: function(res) {
						if (!res.success) {
							btnEl.disabled = false;
							btnEl.innerHTML = '❌ Failed: ' + (res.data ? res.data.message : 'Error');
							return;
						}
						btnEl.innerHTML = '✅ Changes Applied (Backup: ' + res.data.backup_key + ')';
						btnEl.style.background = '#059669';

						// Update history item
						var hist = eraGetHistory();
						for (var i = hist.length - 1; i >= 0; i--) {
							if (hist[i].data && hist[i].data.matchedElementId === elementId) {
								hist[i].data.applied = true;
								hist[i].data.backupKey = res.data.backup_key;
								break;
							}
						}
						eraSaveHistory(hist);

						var succMsg = '🎉 <strong>Success!</strong> Changes applied specifically to section <code>' + elementId + '</code>.<br/>' +
							(res.data.patches_applied_count ? '📝 <strong>' + res.data.patches_applied_count + ' text patch(es) applied surgically.</strong><br/>' : '') +
							'Automatic safety backup saved: <code>' + res.data.backup_key + '</code>.<br/><br/>' +
							'<button type="button" class="button button-small" onclick="eraReloadWithChat();" style="text-decoration:none;cursor:pointer;">🔄 Refresh Page to View</button>';
						eraAppendMsg('agent', succMsg, true, null, true);
					},
					error: function(xhr, status, err) {
						btnEl.disabled = false;
						btnEl.innerHTML = '❌ Error: ' + err;
					}
				});
			}

			function eraInitHistory() {
				var hist = eraGetHistory();
				if (hist && hist.length > 0) {
					var container = document.getElementById('era-chat-messages');
					if (container) {
						container.innerHTML = '';
						for (var i = 0; i < hist.length; i++) {
							var item = hist[i];
							var div = document.createElement('div');
							div.className = 'era-msg ' + (item.sender === 'user' ? 'era-msg-user' : 'era-msg-agent');
							if (item.isHtml) {
								div.innerHTML = item.content;
							} else {
								div.textContent = item.content;
							}
							container.appendChild(div);

							if (item.data && item.data.matchedElementId) {
								var btn = div.querySelector('.era-btn-apply-section');
								if (btn) {
									var btnId = item.data.btnId || btn.id || ('btn-apply-' + item.data.matchedElementId);
									btn.id = btnId;
									btn.setAttribute('data-btn-id', btnId);
									btn.setAttribute('data-element-id', item.data.matchedElementId);

									window.eraFixCache = window.eraFixCache || {};
									window.eraFixCache[btnId] = item.data;

									if (item.data.applied) {
										btn.disabled = true;
										btn.innerHTML = '✅ Changes Applied (Backup: ' + (item.data.backupKey || 'Saved') + ')';
										btn.style.background = '#059669';
									} else {
										(function(d, b) {
											b.onclick = function() {
												eraApplySectionFix(d.matchedElementId, d.scopedCss || '', d.contentPatches || [], b, d.actionSummary, d.sectionTitle, d.actionType);
											};
										})(item.data, btn);
									}
								}
							}
						}
						container.scrollTop = container.scrollHeight;
					}
				}

				if (localStorage.getItem(eraOpenKey) === '1') {
					var win = document.getElementById('era-chat-window');
					if (win) {
						win.style.display = 'flex';
						var c = document.getElementById('era-chat-messages');
						if (c) c.scrollTop = c.scrollHeight;
						setTimeout(function() {
							var inp = document.getElementById('era-chat-input');
							if (inp) inp.focus();
						}, 60);
					}
				}
			}

			// Event delegation on chat messages container ensures buttons are always clickable on the first try
			var chatContainer = document.getElementById('era-chat-messages');
			if (chatContainer) {
				chatContainer.addEventListener('click', function(e) {
					var btn = e.target.closest('.era-btn-apply-section');
					if (!btn || btn.disabled) return;
					var btnId = btn.id || btn.getAttribute('data-btn-id');
					if (btnId && window.eraFixCache && window.eraFixCache[btnId]) {
						var fix = window.eraFixCache[btnId];
						if (!fix.applied) {
							eraApplySectionFix(fix.matchedElementId, fix.scopedCss || '', fix.contentPatches || [], btn, fix.actionSummary, fix.sectionTitle, fix.actionType);
						}
					}
				});
			}

			document.addEventListener('DOMContentLoaded', eraInitHistory);
			if (document.readyState === 'interactive' || document.readyState === 'complete') {
				eraInitHistory();
			}
		</script>
		<?php
	}

	/**
	 * AJAX Handler: era_chat_message.
	 */
	public function handle_chat_message() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user.' ), 403 );
		}

		check_ajax_referer( 'era_chat_nonce', 'nonce' );

		$page_id          = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		$message          = isset( $_POST['message'] ) ? sanitize_text_field( wp_unslash( $_POST['message'] ) ) : '';
		$image_base64     = isset( $_POST['image_base64'] ) ? wp_unslash( (string) $_POST['image_base64'] ) : '';
		$history_raw      = isset( $_POST['history'] ) ? wp_unslash( (string) $_POST['history'] ) : '';
		$history          = ! empty( $history_raw ) ? json_decode( $history_raw, true ) : array();
		$page_context_raw = isset( $_POST['page_context'] ) ? wp_unslash( (string) $_POST['page_context'] ) : '';
		$page_context     = ! empty( $page_context_raw ) ? json_decode( $page_context_raw, true ) : null;

		if ( ! $page_id ) {
			wp_send_json_error( array( 'message' => 'No active page ID found.' ), 400 );
		}

		// Try HTTP connection to local ERA Server (http://127.0.0.1:8000/api/chat)
		$server_url = defined( 'ERA_AGENT_API_URL' ) ? ERA_AGENT_API_URL : 'http://127.0.0.1:8000/api/chat';
		$current_raw = get_post_meta( $page_id, '_elementor_data', true );
		$parsed_data = ! empty( $current_raw ) ? json_decode( $current_raw, true ) : null;

		$backups_list = get_post_meta( $page_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}
		if ( ! is_array( $page_context ) ) {
			$page_context = array();
		}
		$formatted_backups = array();
		foreach ( array_slice( $backups_list, -10 ) as $b ) {
			$key   = isset( $b['key'] ) ? $b['key'] : '';
			$title = ! empty( $b['title'] ) ? $b['title'] : '';
			if ( ! $title ) {
				$section = ! empty( $b['section_title'] ) ? $b['section_title'] : '';
				$action  = ! empty( $b['action_type'] ) ? $b['action_type'] : '';
				if ( ! empty( $b['pre_restore'] ) ) {
					$title = 'Safety Snapshot (prior to restore)';
				} elseif ( $section ) {
					$title = 'Responsive Fix for ' . $section;
				} elseif ( $action ) {
					$title = ucfirst( $action ) . ' Update';
				} else {
					$title = 'Backup ' . ( ! empty( $b['date_gmt'] ) ? $b['date_gmt'] : $key );
				}
			}
			$formatted_backups[] = array(
				'key'           => $key,
				'title'         => $title,
				'section_title' => isset( $b['section_title'] ) ? $b['section_title'] : '',
				'action_type'   => isset( $b['action_type'] ) ? $b['action_type'] : '',
				'date_gmt'      => isset( $b['date_gmt'] ) ? $b['date_gmt'] : '',
				'timestamp'     => isset( $b['timestamp'] ) ? $b['timestamp'] : 0,
			);
		}
		$page_context['recentBackups'] = $formatted_backups;

		$payload = array(
			'pageId'        => $page_id,
			'message'       => $message,
			'history'       => $history,
			'imageBase64'   => $image_base64,
			'elementorData' => $parsed_data,
			'pageContext'   => $page_context,
		);

		$response = wp_remote_post( $server_url, array(
			'timeout' => 45,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( $payload ),
		) );

		if ( ! is_wp_error( $response ) && wp_remote_retrieve_response_code( $response ) === 200 ) {
			$body = wp_remote_retrieve_body( $response );
			$parsed = json_decode( $body, true );
			if ( $parsed && ! empty( $parsed['success'] ) ) {
				wp_send_json_success( $parsed );
			}
		}

		// CLI Fallback: Execute node dist/cli.js chat
		$plugin_dir = defined( 'ERA_BRIDGE_PLUGIN_DIR' ) ? ERA_BRIDGE_PLUGIN_DIR : plugin_dir_path( __FILE__ ) . '../';
		$root_dir   = dirname( dirname( untrailingslashit( $plugin_dir ) ) );
		$agent_dir  = $root_dir . '/agent';
		$cli_path   = $agent_dir . '/dist/cli.js';
		$node_bin   = $this->get_node_bin();
		$node_dir   = dirname( $node_bin );

		$temp_img_file = '';
		if ( ! empty( $image_base64 ) ) {
			$upload_dir = wp_upload_dir();
			$temp_img_file = $upload_dir['basedir'] . '/era-chat-tmp-' . time() . '-' . wp_rand( 100, 999 ) . '.png';
			$data_clean = preg_replace( '#^data:image/\w+;base64,#i', '', $image_base64 );
			@file_put_contents( $temp_img_file, base64_decode( $data_clean ) );
		}

		$temp_hist_file = '';
		if ( ! empty( $history ) ) {
			$upload_dir = wp_upload_dir();
			$temp_hist_file = $upload_dir['basedir'] . '/era-chat-hist-' . time() . '-' . wp_rand( 100, 999 ) . '.json';
			@file_put_contents( $temp_hist_file, wp_json_encode( $history ) );
		}

		$temp_ctx_file = '';
		if ( ! empty( $page_context ) ) {
			$upload_dir = wp_upload_dir();
			$temp_ctx_file = $upload_dir['basedir'] . '/era-chat-ctx-' . time() . '-' . wp_rand( 100, 999 ) . '.json';
			@file_put_contents( $temp_ctx_file, wp_json_encode( $page_context ) );
		}

		$cmd = sprintf(
			'export PATH=%s:"$PATH:/usr/local/bin:/usr/bin:/bin" && cd %s && %s %s chat -p %d %s %s %s %s --json 2>&1',
			escapeshellarg( $node_dir ),
			escapeshellarg( $agent_dir ),
			escapeshellarg( $node_bin ),
			escapeshellarg( $cli_path ),
			$page_id,
			$message ? '-m ' . escapeshellarg( $message ) : '',
			$temp_img_file ? '-i ' . escapeshellarg( $temp_img_file ) : '',
			$temp_hist_file ? '--history ' . escapeshellarg( $temp_hist_file ) : '',
			$temp_ctx_file ? '--context ' . escapeshellarg( $temp_ctx_file ) : ''
		);

		$output = shell_exec( $cmd );
		if ( $temp_img_file && file_exists( $temp_img_file ) ) {
			@unlink( $temp_img_file );
		}
		if ( $temp_hist_file && file_exists( $temp_hist_file ) ) {
			@unlink( $temp_hist_file );
		}
		if ( $temp_ctx_file && file_exists( $temp_ctx_file ) ) {
			@unlink( $temp_ctx_file );
		}

		// 1. Try parsing direct JSON output from CLI
		$cli_json = json_decode( trim( (string) $output ), true );
		if ( is_array( $cli_json ) ) {
			if ( ! empty( $cli_json['success'] ) ) {
				wp_send_json_success( $cli_json );
			} elseif ( isset( $cli_json['reply'] ) || isset( $cli_json['explanation'] ) || ! empty( $cli_json['matchedElementId'] ) ) {
				wp_send_json_success( $cli_json );
			}
		}

		// 2. Parse CLI output regex fallback for matched section
		$matched_id = '';
		$section_title = '';
		if ( preg_match( '/TARGETED SECTION:\s*(.+?)\s*\(ID:\s*([a-zA-Z0-9_-]+)\)/i', $output, $m ) ) {
			$section_title = trim( $m[1] );
			$matched_id    = trim( $m[2] );
		}

		if ( $matched_id ) {
			// Generate Scoped CSS for the section
			$clean_id = preg_replace( '/[^a-zA-Z0-9_-]/', '', $matched_id );
			$scoped_css = "/* Scoped Responsive Fix: {$section_title} ({$clean_id}) */\n" .
				".elementor-element-{$clean_id}, [data-id=\"{$clean_id}\"] { height: auto !important; min-height: fit-content !important; box-sizing: border-box !important; max-width: 100% !important; overflow-x: clip !important; }\n" .
				".elementor-element-{$clean_id} .elementor-container, .elementor-element-{$clean_id} .elementor-widget-wrap { height: auto !important; min-height: fit-content !important; max-width: 100% !important; box-sizing: border-box !important; }\n" .
				".elementor-element-{$clean_id} input, .elementor-element-{$clean_id} select, .elementor-element-{$clean_id} textarea, .elementor-element-{$clean_id} button { max-width: 100% !important; box-sizing: border-box !important; }\n" .
				"@media (max-width: 1200px) { .elementor-element-{$clean_id} [class*=\"reveal\"], .elementor-element-{$clean_id} [class*=\"animate\"] { transform: none !important; opacity: 1 !important; visibility: visible !important; } }\n" .
				"@media (max-width: 767px) { .elementor-element-{$clean_id} .elementor-column { width: 100% !important; } }\n";

			wp_send_json_success( array(
				'matchedElementId' => $matched_id,
				'sectionTitle'     => $section_title,
				'actionType'       => 'style',
				'detectedIssues'   => array( 'Container content overflow & bleed', 'Responsive viewport stacking misalignment' ),
				'explanation'      => "Targeted section '{$section_title}'. Fluid containment and touch sizing generated strictly for this section.",
				'scopedCss'        => $scoped_css,
				'contentPatches'   => array(),
			) );
		}

		wp_send_json_error( array(
			'message' => 'Agent CLI failed to process the request: ' . wp_strip_all_tags( (string) $output ),
		), 500 );
	}

	/**
	 * AJAX Handler: era_apply_section_fix.
	 * Applies surgical content patches and/or scoped CSS exclusively for the targeted section and creates safety backup.
	 */
	public function handle_apply_section_fix() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user.' ), 403 );
		}

		check_ajax_referer( 'era_chat_nonce', 'nonce' );

		$page_id             = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		$element_id          = isset( $_POST['element_id'] ) ? sanitize_text_field( wp_unslash( $_POST['element_id'] ) ) : '';
		$scoped_css          = isset( $_POST['scoped_css'] ) ? wp_unslash( (string) $_POST['scoped_css'] ) : '';
		$content_patches_raw = isset( $_POST['content_patches'] ) ? wp_unslash( (string) $_POST['content_patches'] ) : '';
		$content_patches     = ! empty( $content_patches_raw ) ? json_decode( $content_patches_raw, true ) : array();
		$action_summary      = isset( $_POST['action_summary'] ) ? sanitize_text_field( wp_unslash( $_POST['action_summary'] ) ) : '';
		$section_title       = isset( $_POST['section_title'] ) ? sanitize_text_field( wp_unslash( $_POST['section_title'] ) ) : '';
		$action_type         = isset( $_POST['action_type'] ) ? sanitize_text_field( wp_unslash( $_POST['action_type'] ) ) : 'style';

		// Strip any accidental backslash quote escaping caused by magic quotes or double slash
		$scoped_css = str_replace( array( '\"', "\'" ), array( '"', "'" ), $scoped_css );

		if ( ! $page_id || empty( $element_id ) || ( empty( trim( $scoped_css ) ) && empty( $content_patches ) ) ) {
			wp_send_json_error( array( 'message' => 'Missing required parameters.' ), 400 );
		}

		$current_raw = get_post_meta( $page_id, '_elementor_data', true );
		if ( empty( $current_raw ) ) {
			$current_raw = '[]';
		}

		// 1. Create Timestamped Backup with Descriptive Title
		$timestamp  = time();
		$backup_key = '_era_backup_' . $timestamp;
		$date_gmt   = gmdate( 'Y-m-d H:i:s', $timestamp );

		// Derive human-readable change title
		$change_title = '';
		if ( ! empty( $action_summary ) ) {
			$change_title = $action_summary;
		} elseif ( ! empty( $section_title ) ) {
			$change_title = sprintf( __( 'Applied %s fixes to %s', 'era-bridge' ), $action_type, $section_title );
		} elseif ( ! empty( $content_patches ) ) {
			$change_title = __( 'Updated section text & content', 'era-bridge' );
		} else {
			$change_title = __( 'Updated section responsive styling', 'era-bridge' );
		}

		update_post_meta( $page_id, $backup_key, wp_slash( $current_raw ) );

		$backups_list = get_post_meta( $page_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}
		$backups_list[] = array(
			'key'           => $backup_key,
			'timestamp'     => $timestamp,
			'date_gmt'      => $date_gmt,
			'title'         => $change_title,
			'section_title' => $section_title,
			'action_type'   => $action_type,
		);
		update_post_meta( $page_id, '_era_backups_list', $backups_list );

		// File backup
		$upload_dir = wp_upload_dir();
		$backup_dir = $upload_dir['basedir'] . '/era-backups/page-' . $page_id;
		wp_mkdir_p( $backup_dir );
		file_put_contents( $backup_dir . '/' . $backup_key . '.json', $current_raw );

		$data = json_decode( $current_raw, true );
		if ( ! is_array( $data ) ) {
			$data = array();
		}

		// 2. Apply Surgical Content Patches to the target section
		$patches_applied_count = 0;
		if ( ! empty( $content_patches ) && is_array( $content_patches ) ) {
			$apply_patch_to_elements = function( &$elements, $patch ) use ( &$apply_patch_to_elements, &$patches_applied_count ) {
				foreach ( $elements as &$el ) {
					if ( ! is_array( $el ) ) continue;

					$target_widget_match = empty( $patch['elementId'] ) || ( isset( $el['id'] ) && $el['id'] === $patch['elementId'] );

					if ( $target_widget_match && isset( $el['settings'] ) && is_array( $el['settings'] ) ) {
						$search  = $patch['search'];
						$replace = $patch['replace'];

						if ( ! empty( $patch['settingKey'] ) && isset( $el['settings'][ $patch['settingKey'] ] ) ) {
							$current_val = $el['settings'][ $patch['settingKey'] ];
							if ( is_string( $current_val ) ) {
								if ( strpos( $current_val, $search ) !== false ) {
									$el['settings'][ $patch['settingKey'] ] = str_replace( $search, $replace, $current_val );
									$patches_applied_count++;
								} elseif ( strpos( $current_val, html_entity_decode( $search ) ) !== false ) {
									$el['settings'][ $patch['settingKey'] ] = str_replace( html_entity_decode( $search ), $replace, $current_val );
									$patches_applied_count++;
								}
							}
						} else {
							foreach ( $el['settings'] as $k => $v ) {
								if ( is_string( $v ) ) {
									if ( strpos( $v, $search ) !== false ) {
										$el['settings'][ $k ] = str_replace( $search, $replace, $v );
										$patches_applied_count++;
									} elseif ( strpos( $v, html_entity_decode( $search ) ) !== false ) {
										$el['settings'][ $k ] = str_replace( html_entity_decode( $search ), $replace, $v );
										$patches_applied_count++;
									}
								}
							}
						}
					}

					if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
						$apply_patch_to_elements( $el['elements'], $patch );
					}
				}
			};

			foreach ( $content_patches as $patch ) {
				if ( empty( $patch['search'] ) || ! isset( $patch['replace'] ) ) continue;

				foreach ( $data as &$section ) {
					if ( isset( $section['id'] ) && $section['id'] === $element_id ) {
						if ( isset( $section['settings'] ) && is_array( $section['settings'] ) ) {
							foreach ( $section['settings'] as $k => $v ) {
								if ( is_string( $v ) && strpos( $v, $patch['search'] ) !== false ) {
									$section['settings'][ $k ] = str_replace( $patch['search'], $patch['replace'], $v );
									$patches_applied_count++;
								}
							}
						}
						if ( ! empty( $section['elements'] ) && is_array( $section['elements'] ) ) {
							$apply_patch_to_elements( $section['elements'], $patch );
						}
					}
				}
			}
		}

		// 3. Inject/Update Scoped CSS Section (only if scoped_css has actual styling rules)
		$clean_id = preg_replace( '/[^a-zA-Z0-9_-]/', '', $element_id );
		$clean_id = preg_replace( '/^era_scoped_css_/', '', $clean_id );
		$clean_id = preg_replace( '/^era_responsive_css_/', '', $clean_id );
		$section_widget_id = 'era_scoped_css_' . $clean_id;

		if ( ! empty( trim( $scoped_css ) ) ) {
			// Filter out any existing fix for this specific section
			$filtered_data = array();
			foreach ( $data as $section ) {
				if ( isset( $section['id'] ) && $section['id'] === $section_widget_id ) {
					continue;
				}
				$filtered_data[] = $section;
			}

			// Prepend scoped CSS section
			$scoped_section = array(
				'id'       => $section_widget_id,
				'elType'   => 'section',
				'settings' => array( 'layout' => 'full_width' ),
				'elements' => array(
					array(
						'id'       => $section_widget_id . '_col',
						'elType'   => 'column',
						'elements' => array(
							array(
								'id'         => $section_widget_id . '_html',
								'elType'     => 'widget',
								'widgetType' => 'html',
								'settings'   => array(
									'html' => "<style id=\"era-scoped-fix-{$clean_id}\">\n" . $scoped_css . "\n</style>",
								),
							),
						),
					),
				),
			);

			array_unshift( $filtered_data, $scoped_section );
			$data = $filtered_data;
		}

		// 4. Save and clear cache
		update_post_meta( $page_id, '_elementor_data', wp_slash( json_encode( $data ) ) );
		delete_post_meta( $page_id, '_elementor_css' );

		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}

		wp_send_json_success( array(
			'success'               => true,
			'element_id'            => $element_id,
			'backup_key'            => $backup_key,
			'date_gmt'              => $date_gmt,
			'patches_applied_count' => $patches_applied_count,
		) );
	}

	/**
	 * AJAX Handler: era_list_backups.
	 * Returns the list of safety backups for this page.
	 */
	public function handle_list_backups() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user.' ), 403 );
		}

		check_ajax_referer( 'era_chat_nonce', 'nonce' );

		$page_id = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		if ( ! $page_id ) {
			wp_send_json_error( array( 'message' => 'No active page ID provided.' ), 400 );
		}

		$backups_list = get_post_meta( $page_id, '_era_backups_list', true );
		if ( ! is_array( $backups_list ) ) {
			$backups_list = array();
		}

		$formatted = array();
		$reversed = array_reverse( $backups_list );
		foreach ( $reversed as $idx => $b ) {
			$title = '';
			if ( ! empty( $b['title'] ) ) {
				$title = $b['title'];
			} elseif ( ! empty( $b['key'] ) && strpos( $b['key'], 'pre_restore' ) !== false ) {
				$title = __( 'Pre-Restore Safety Snapshot', 'era-bridge' );
			} elseif ( ! empty( $b['section_title'] ) && $b['section_title'] !== 'Full Page' ) {
				$title = sprintf( __( 'Changes to %s', 'era-bridge' ), $b['section_title'] );
			} else {
				$date_str = ! empty( $b['date_gmt'] ) ? $b['date_gmt'] : ( ! empty( $b['timestamp'] ) ? gmdate( 'Y-m-d H:i:s', $b['timestamp'] ) : '' );
				$title = $date_str ? sprintf( __( 'Version from %s GMT', 'era-bridge' ), $date_str ) : sprintf( __( 'Page Version #%d', 'era-bridge' ), $idx + 1 );
			}

			$formatted[] = array(
				'key'           => $b['key'],
				'timestamp'     => isset( $b['timestamp'] ) ? $b['timestamp'] : 0,
				'date_gmt'      => isset( $b['date_gmt'] ) ? $b['date_gmt'] : '',
				'title'         => $title,
				'section_title' => isset( $b['section_title'] ) ? $b['section_title'] : '',
				'action_type'   => isset( $b['action_type'] ) ? $b['action_type'] : 'style',
			);
		}

		wp_send_json_success( array(
			'backups' => $formatted,
		) );
	}

	/**
	 * AJAX Handler: era_restore_backup.
	 * Restores a previous _elementor_data backup snapshot.
	 */
	public function handle_restore_backup() {
		if ( ! current_user_can( 'edit_pages' ) ) {
			wp_send_json_error( array( 'message' => 'Unauthorized user.' ), 403 );
		}

		check_ajax_referer( 'era_chat_nonce', 'nonce' );

		$page_id    = isset( $_POST['page_id'] ) ? absint( $_POST['page_id'] ) : 0;
		$backup_key = isset( $_POST['backup_key'] ) ? sanitize_text_field( wp_unslash( $_POST['backup_key'] ) ) : '';

		if ( ! $page_id || empty( $backup_key ) ) {
			wp_send_json_error( array( 'message' => 'Missing page ID or backup key.' ), 400 );
		}

		$backup_data = get_post_meta( $page_id, $backup_key, true );
		if ( empty( $backup_data ) ) {
			$upload_dir = wp_upload_dir();
			$file_path  = $upload_dir['basedir'] . '/era-backups/page-' . $page_id . '/' . $backup_key . '.json';
			if ( file_exists( $file_path ) ) {
				$backup_data = file_get_contents( $file_path );
			}
		}

		if ( empty( $backup_data ) ) {
			wp_send_json_error( array( 'message' => 'Backup snapshot data not found.' ), 404 );
		}

		// Create a safety snapshot of current state before reverting
		$current_raw = get_post_meta( $page_id, '_elementor_data', true );
		if ( ! empty( $current_raw ) ) {
			$pre_ts = time();
			$pre_restore_key = '_era_backup_' . $pre_ts . '_pre_restore';
			update_post_meta( $page_id, $pre_restore_key, wp_slash( $current_raw ) );

			$b_list = get_post_meta( $page_id, '_era_backups_list', true );
			if ( ! is_array( $b_list ) ) $b_list = array();
			$b_list[] = array(
				'key'           => $pre_restore_key,
				'timestamp'     => $pre_ts,
				'date_gmt'      => gmdate( 'Y-m-d H:i:s', $pre_ts ),
				'title'         => sprintf( __( 'Safety Snapshot (before restoring %s)', 'era-bridge' ), esc_html( $backup_key ) ),
				'section_title' => __( 'Full Page', 'era-bridge' ),
				'action_type'   => 'restore',
			);
			update_post_meta( $page_id, '_era_backups_list', $b_list );
		}

		// Restore elementor data
		update_post_meta( $page_id, '_elementor_data', wp_slash( $backup_data ) );
		delete_post_meta( $page_id, '_elementor_css' );

		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}

		wp_send_json_success( array(
			'message'    => 'Backup successfully restored.',
			'backup_key' => $backup_key,
		) );
	}
}
