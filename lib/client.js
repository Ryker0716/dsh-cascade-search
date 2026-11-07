window.__ModuleLoader__.load({
	id: "dsh-cascade-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var P = require("@deepseek-ai/dsh-client-ui-primitives");
		var S = require("@deepseek-ai/dsh-client-store");

		var h = React.createElement;

		//#region configuration surface
		/**
		 * Locale namespace owned by this bundle. Separate from the Host config
		 * namespace below: one keys copy, the other keys a settings document.
		 */
		var NS = "cascade-search";

		/**
		 * Package name the Host keys a bundle's own configuration page by.
		 *
		 * `plugins.bundle.config` is keyed by the BUNDLE's package name — the string
		 * `dsh plugin add` installs — not by the locale namespace and not by the
		 * loader row id.
		 */
		var PACKAGE_NAME = "dsh-cascade-search";

		/**
		 * Settings namespace this page edits: the loader row id from
		 * `cordis.patch.yml`, which is what the Host reports as `ns`.
		 */
		var ENTRY_NS = "cascade-search";


		/** Backends in default priority order, with the label shown in the UI. */
		var BACKENDS = [
			{
				id: "tavily",
				label: "tavily-proxy",
				hintKey: "tavilyHint",
				hasDepth: true,
			},
			{
				id: "querit",
				label: "Querit",
				hintKey: "queritHint",
				hasDepth: false,
			},
			{
				id: "deepseek",
				label: "DeepSeek Search API",
				hintKey: "deepseekHint",
				hasDepth: false,
			},
		];

		/** Every field the projection publishes, so a hook snapshot is plain data. */
		var ALL_FIELDS = [
			"order",
			"adopt",
			"tavilyEnabled",
			"tavilyUrl",
			"tavilyCredentialRef",
			"tavilyTimeoutMs",
			"tavilyDepth",
			"queritEnabled",
			"queritUrl",
			"queritCredentialRef",
			"queritTimeoutMs",
			"deepseekEnabled",
			"deepseekUrl",
			"deepseekCredentialRef",
			"deepseekTimeoutMs",
			"tavilyKey",
			"queritKey",
			"deepseekKey",
		];

		/** Form field a backend's secret is staged under. */
		var keyField = function (id) {
			return id + "Key";
		}
		//#endregion

		//#region field specs
		/**
		 * Boolean spec for a `z.boolean()` field.
		 *
		 * The primitives package ships text and number specs only, and the shared
		 * form model speaks strings, so a boolean is carried as the literal text
		 * `"true"` / `"false"`. The page drives it with a Switch rather than a text
		 * box, but the staged value still travels the ordinary `set` path.
		 *
		 * @param field - config field name.
		 * @returns the form model spec.
		 */
		function settingsBooleanField(field) {
			return {
				field: field,
				format: function (value) {
					return value === true ? "true" : value === false ? "false" : "";
				},
				parse: function (text) {
					var raw = text.trim().toLowerCase();
					if (raw === "") return { kind: "clear" };
					if (raw === "true") return { kind: "set", value: true };
					if (raw === "false") return { kind: "set", value: false };
					return undefined;
				},
			};
		}

		/**
		 * Priority-list spec for the `order` field.
		 *
		 * Comma-separated on screen, array on the wire. A name outside the known
		 * backends is rejected here so the Host never stores an order the engine
		 * would have to skip, and duplicates are dropped rather than refused.
		 *
		 * @param field - config field name.
		 * @returns the form model spec.
		 */
		function settingsOrderField(field) {
			var known = BACKENDS.map(function (backend) {
				return backend.id;
			});
			return {
				field: field,
				format: function (value) {
					return Array.isArray(value) ? value.join(", ") : "";
				},
				parse: function (text) {
					var raw = text.trim();
					if (raw === "") return { kind: "clear" };
					var names = raw
						.split(",")
						.map(function (item) {
							return item.trim();
						})
						.filter(function (item) {
							return item.length > 0;
						});
					if (names.length === 0) return undefined;
					var seen = [];
					for (var index = 0; index < names.length; index += 1) {
						var name = names[index];
						if (known.indexOf(name) === -1) return undefined;
						if (seen.indexOf(name) === -1) seen.push(name);
					}
					return { kind: "set", value: seen };
				},
			};
		}
		function settingsCredentialRefField(field) {
			return {
				...P.settingsTextField(field),
				parse: function (text) {
					var value = text.trim();
					if (value === "") return { kind: "clear" };
					return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? { kind: "set", value: value } : void 0;
				},
			};
		}

		function settingsTimeoutField(field) {
			return {
				...P.settingsNumberField(field),
				parse: function (text) {
					if (text.trim() === "") return { kind: "clear" };
					var value = Number(text);
					return Number.isSafeInteger(value) && value >= 1 && value <= 600000
						? { kind: "set", value: value } : void 0;
				},
			};
		}

		function settingsUrlField(field) {
			return {
				...P.settingsTextField(field),
				parse: function (text) {
					var value = text.trim();
					if (value === "") return { kind: "clear" };
					try {
						var url = new URL(value);
						if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return void 0;
						return { kind: "set", value: value };
					} catch { return void 0; }
				},
			};
		}

		function settingsDepthField(field) {
			return {
				...P.settingsTextField(field),
				parse: function (text) {
					var value = text.trim();
					if (value === "") return { kind: "clear" };
					return value === "basic" || value === "advanced" ? { kind: "set", value: value } : void 0;
				},
			};
		}
		//#endregion

		//#region controller
		/**
		 * Bridges the settings scope and the credentials domain onto the page.
		 *
		 * The page edits ONE settings namespace, but the credentials half lives
		 * outside it: a secret's literal never rides a settings response, so the
		 * page learns only whether one is configured — through
		 * `remote.credentials.describe` — and writes it through
		 * `remote.credentials.set`, addressed by the reference the matching config
		 * field names. Both are staged into the same form, so one Save covers the
		 * whole page.
		 */
		var CascadeCardController = class {
			constructor(scope, ctx) {
				var specs = [settingsOrderField("order"), settingsBooleanField("adopt")];
				for (var index = 0; index < BACKENDS.length; index += 1) {
					var id = BACKENDS[index].id;
					specs.push(settingsBooleanField(id + "Enabled"));
					specs.push(settingsUrlField(id + "Url"));
					specs.push(settingsCredentialRefField(id + "CredentialRef"));
					specs.push(settingsTimeoutField(id + "TimeoutMs"));
				}
				specs.push(settingsDepthField("tavilyDepth"));

				var self = this;
				this.scope = scope;
				this.ctx = ctx;
				this.credentials = {};
				this.credentialSequences = {};
				this.credentialDedupler = this.createCredentialBatcher();
				this.disposed = false;
				this.savePromise = null;
				this.form = new P.SettingsFormModel(
					scope,
					specs,
					BACKENDS.map(function (backend) {
						return {
							field: keyField(backend.id),
							write: function (text) {
								return self.writeKey(backend.id, text, self.refOf(backend.id));
							},
						};
					}),
				);
				this.store = S.createSnapshotStore(this.projection());
				var publish = function () {
					if (self.disposed) return;
					self.store.set(self.projection());
					for (var index = 0; index < BACKENDS.length; index += 1) {
						var id = BACKENDS[index].id;
						var credential = self.credentials[id];
						if (credential?.ref !== self.refOf(id) || credential?.error) self.readCredential(id);
					}
				};
				this.unsubscribe = [
					this.form.bind(function () {
						return self.form.shell();
					}).subscribe(publish),
					scope.subscribe(function () {
						self.readAllCredentials();
						// Invalid ref edits do not change the scope and the queued read
						// may never run; publish the form's new invalid flag synchronously.
						self.store.set(self.projection());
					}),
				];
				this.readAllCredentials();
			}

			/** The snapshot the page renders. */
			projection() {
				var shell = this.form.shell();
				var fields = {};
				for (var index = 0; index < ALL_FIELDS.length; index += 1) {
					fields[ALL_FIELDS[index]] = this.form.field(ALL_FIELDS[index]);
				}
				var credentials = {};
				for (var backendIndex = 0; backendIndex < BACKENDS.length; backendIndex += 1) {
					var backendId = BACKENDS[backendIndex].id;
					credentials[backendId] = this.credentials[backendId] ?? {
						ref: "",
						configured: false,
						writable: true,
					};
				}
				return {
					available: shell.available,
					writable: shell.writable,
					dirty: shell.dirty,
					invalid: shell.invalid,
					saving: shell.saving,
					failed: shell.failed,
					fields: fields,
					credentials: credentials,
					adopted: fields.adopt.text === "true",
				};
			}

			/** The reference name a backend's credential field currently holds. */
			refOf(id) {
				return this.form.field(id + "CredentialRef").text.trim();
			}

			/** Re-read every backend's credential state through one batched request. */
			readAllCredentials() {
				this.credentialDedupler.readAll();
			}

			/**
			 * Debounce config notifications and issue at most one describe for all
			 * three tiers, while invalidating older responses immediately.
			 */
			createCredentialBatcher() {
				var self = this;
				var queued = false;
				var wait = null;
				function flush() {
					queued = false;
					wait = null;
					var refs = [];
					var owners = {};
					var generations = {};
					for (var index = 0; index < BACKENDS.length; index += 1) {
						var id = BACKENDS[index].id;
						var ref = self.refOf(id);
						var generation = (self.credentialSequences[id] ?? 0) + 1;
						self.credentialSequences[id] = generation;
						generations[id] = generation;
						// Never show A's credential under an edited B ref while it loads.
						self.publishCredential(id, { ref: ref, configured: false, writable: true, loading: ref !== "" });
						if (ref !== "") {
							refs.push(ref);
							owners[ref] ??= [];
							owners[ref].push(id);
						}
					}
					if (refs.length === 0 || self.disposed) return Promise.resolve();
					return self.ctx.remote.credentials.describe([...new Set(refs)]).then(function (response) {
						for (var index = 0; index < BACKENDS.length; index += 1) {
							var id = BACKENDS[index].id;
							if (self.disposed || self.credentialSequences[id] !== generations[id]) continue;
							var ref = self.refOf(id);
							if (refs.indexOf(ref) === -1) continue;
							var view = response?.ok === true ? response.value?.[ref] : void 0;
							self.publishCredential(id, view ? {
								ref: ref, configured: view.configured === true, writable: view.writable !== false,
							} : {
								ref: ref, configured: false, writable: true, error: true,
							});
						}
					}).catch(function () {
						for (var index = 0; index < BACKENDS.length; index += 1) {
							var id = BACKENDS[index].id;
							if (self.disposed || self.credentialSequences[id] !== generations[id]) continue;
							var ref = self.refOf(id);
							if (refs.indexOf(ref) !== -1) self.publishCredential(id, { ref: ref, configured: false, writable: true, error: true });
						}
					});
				}
				return {
					readAll: function () {
						if (self.disposed) return Promise.resolve();
						if (!queued) {
							queued = true;
							wait = Promise.resolve().then(flush);
						}
						return wait;
					},
					flush: function () {
						if (queued) return flush();
						return Promise.resolve();
					},
				};
			}

			/**
			 * Ask the credentials domain about one reference.
			 *
			 * The answer is stored with the reference it describes: `credentialRef`
			 * can be edited between the request and its response, and two reads can
			 * settle out of order, so a response is published only while it still
			 * answers for the reference in force.
			 */
			async readCredential(id) {
				var ref = this.refOf(id);
				var generation = (this.credentialSequences[id] ?? 0) + 1;
				this.credentialSequences[id] = generation;
				this.publishCredential(id, { ref: ref, configured: false, writable: true, loading: ref !== "" });
				if (ref === "") return false;
				var response;
				try {
					response = await this.ctx.remote.credentials.describe([ref]);
				} catch {
					if (!this.disposed && this.credentialSequences[id] === generation && ref === this.refOf(id)) {
						this.publishCredential(id, { ref: ref, configured: false, writable: true, error: true });
					}
					return false;
				}
				if (this.disposed || this.credentialSequences[id] !== generation || ref !== this.refOf(id)) return false;
				var view = response?.ok === true ? response.value?.[ref] : undefined;
				if (!view) {
					this.publishCredential(id, { ref: ref, configured: false, writable: true, error: true });
					return false;
				}
				this.publishCredential(id, {
					ref: ref,
					configured: view.configured === true,
					writable: view.writable !== false,
				});
				return view.configured === true;
			}

			refOfBackend(backend) {
				return this.refOf(backend.id);
			}

			/** Store one backend's credential state, publishing only on change. */
			publishCredential(id, next) {
				if (this.disposed) return;
				var previous = this.credentials[id];
				this.credentials[id] = next;
				if (
					previous !== undefined &&
					previous.ref === next.ref &&
					previous.configured === next.configured &&
					previous.writable === next.writable &&
					previous.loading === next.loading &&
					previous.error === next.error
				) {
					return;
				}
				this.store.set(this.projection());
			}

			/**
			 * Write one staged secret, then re-read whether the Host now holds one.
			 *
			 * @returns whether a credential is configured afterwards, which is what
			 * the form model reports as the save outcome for a secret row.
			 */
			async writeKey(id, value, ref) {
				if (this.disposed) return false;
				// Freeze the ref at SAVE DELEGATION. Form inputs are disabled during
				// saving; an API/HMR disposal must not write an orphaned credential.
				ref ??= this.refOf(id);
				if (ref === "") return false;
				this.credentialDedupler.flush();
				await this.ctx.remote.credentials.set(ref, value);
				if (this.disposed) return true;
				// The write itself has completed. A failed verification read is an
				// unknown badge, NOT a rejected secret: keep staged drafts out of
				// saveFailed so a retry cannot blindly overwrite another valid key.
				await this.readCredential(id);
				return true;
			}

			/** Drop any credential state whose reference was just invalidated. */
			refreshCredential(ref) {
				for (var index = 0; index < BACKENDS.length; index += 1) {
					if (this.refOf(BACKENDS[index].id) === ref) {
						this.readAllCredentials();
						return;
					}
				}
			}

			/** Props the slot registration injects, plus the form's actions. */
			inject() {
				var self = this;
				// Changing BOTH local reference bookkeeping and the displayed field is
				// separate from choosing whether the persisted edit is set or clear.
				var editReference = function (field, text) {
						var reference = field.slice(-"CredentialRef".length) === "CredentialRef"
							? field.slice(0, -"CredentialRef".length) : "";
						if (reference) {
							// Invalidate the old ref synchronously, BEFORE a queued/bated
							// credential read can freeze it. This is not just deduplication:
							// an in-flight request pending during an edit would otherwise
							// complete with the OLD ref and then be treated as current.
							if (self.credentials[reference]?.ref !== text.trim()) {
								self.credentialSequences[reference] = (self.credentialSequences[reference] ?? 0) + 1;
								self.publishCredential(reference, {
									ref: text.trim(), configured: false, writable: true, loading: text.trim() !== "",
								});
							}
						}
						self.form.actions().edit(field, text);
						if (reference) self.readAllCredentials();
					// Credential-only projection equality may suppress the publication
					// generated by form.stage(); publish local validation state too.
					self.store.set(self.projection());
					};
					return {
					hooks: { cascadeCard: this.store },
					edit: editReference,
					resetField: function (field) {
						var spec = self.form.spec(field);
						// Keep the synchronous credential invalidation/read above, but
						// retain SettingsFormModel's clear:true semantics: Reset must
						// unset the override, not persist `base` as a new explicit value.
						editReference(field, spec.format(self.form.baseValue(field)));
						self.form.actions().resetField(field);
						self.store.set(self.projection());
					},
					save: function () {
						if (self.disposed || self.savePromise) return self.savePromise;
						self.credentialDedupler.flush();
						self.savePromise = self.form.save().finally(function () {
						self.store.set(self.projection());
							self.savePromise = null;
						});
						return self.savePromise;
					},
					discard: function () {
						self.form.actions().discard();
					},
				};
			}

			/** Release every subscription this controller owns. */
			dispose() {
				if (this.disposed) return this.savePromise ?? Promise.resolve();
				this.disposed = true;
				for (var index = 0; index < this.unsubscribe.length; index += 1) {
					this.unsubscribe[index]();
				}
				this.form.dispose();
				// A disposer may be asynchronous: callers can await full settlement
				// before a replacement instance shares the same credential refs.
				return this.savePromise ?? Promise.resolve();
			}
		};
		//#endregion

		//#region rendering
		/** Layout helpers, inlined so the bundle needs no stylesheet route. */
		var style = {
			group: {
				display: "grid",
				gap: "10px",
				padding: "12px 0 4px",
				borderTop: "1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,0.08))",
			},
			groupHead: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				fontSize: "13px",
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)",
			},
			groupHint: {
				margin: 0,
				fontSize: "12px",
				lineHeight: 1.5,
				color: "var(--dsw-alias-label-tertiary)",
			},
			toggleRow: {
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				gap: "16px",
				fontSize: "13px",
				lineHeight: 1.5,
				color: "var(--dsw-alias-label-primary)",
			},
			toggleText: { display: "grid", gap: "2px" },
		};

		/** The form frame's copy, read from this page's dictionary. */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving"),
			};
		}

		/** One labelled switch row, with the hint underneath. */
		function toggle(label, hint, checked, disabled, onChange) {
			return h(
				"label",
				{ style: style.toggleRow, key: label },
				h("span", { style: style.toggleText }, h("span", null, label), h("span", { style: style.groupHint }, hint)),
				h(P.Switch, { checked: checked, label: label, disabled: disabled, onChange: onChange }),
			);
		}

		/** A text/number row wired to the staged form. */
		function valueRow(props, id, field, label, hint, invalidLabel, opts) {
			var options = opts ?? {};
			var state = props.state.fields[field] ?? { text: "", overridden: false, invalid: false };
			return h(P.SettingsValueField, {
				key: field,
				id: "cascade-search-" + id + "-" + field,
				label: label,
				hint: hint,
				overriddenLabel: props.t("overridden"),
				resetLabel: props.t("reset"),
				invalidLabel: invalidLabel,
				numeric: options.numeric === true,
				disabled: props.disabled,
				...state,
				onEdit: function (text) {
					props.props.edit(field, text);
				},
				onReset: function () {
					props.props.resetField(field);
				},
			});
		}

		/** One backend's block: enable, endpoint, credential reference and limits. */
		function backendSection(props, backend) {
			var t = props.t;
			var fields = props.state.fields;
			var credential = props.state.credentials[backend.id] ?? {
				configured: false,
				writable: true,
			};
			var enabled = fields[backend.id + "Enabled"]?.text === "true";
			var keyState = fields[keyField(backend.id)] ?? { text: "" };
			var rows = [
				h(
					"div",
					{ style: style.groupHead, key: "head" },
					backend.label,
					h(P.Tag, {
						tone: enabled ? "neutral" : "quiet",
						children: enabled ? t("enabled") : t("disabledTag"),
					}),
				),
				h("p", { style: style.groupHint, key: "hint" }, t(backend.hintKey)),
				toggle(
					t("enabled"),
					t("enabledHint"),
					enabled,
					props.disabled,
					function (checked) {
						props.props.edit(backend.id + "Enabled", checked ? "true" : "false");
					},
				),
				valueRow(props, backend.id, backend.id + "Url", t("endpoint"), t("endpointHint"), t("invalidText")),
				valueRow(
					props,
					backend.id,
					backend.id + "CredentialRef",
					t("credentialRef"),
					t("credentialRefHint"),
					t("invalidText"),
				),
				h(P.SettingsSecretField, {
					id: "cascade-search-" + backend.id + "-key",
					key: "key",
					label: t("apiKey"),
					hint: t("apiKeyHint"),
					disabled: props.disabled || credential.writable === false,
					text: keyState.text ?? "",
					configured: credential.configured === true,
					stateLabel: credential.error ? t("apiKeyUnknown")
						: credential.loading ? t("apiKeyLoading")
							: credential.configured === true ? t("apiKeySet") : t("apiKeyUnset"),
					onEdit: function (text) {
						props.props.edit(keyField(backend.id), text);
					},
				}),
				valueRow(
					props,
					backend.id,
					backend.id + "TimeoutMs",
					t("timeoutMs"),
					t("timeoutMsHint"),
					t("invalidNumber"),
					{ numeric: true },
				),
			];
			if (backend.hasDepth) {
				rows.push(
					valueRow(props, backend.id, backend.id + "Depth", t("depth"), t("depthHint"), t("invalidText")),
				);
			}
			return h("div", { style: style.group, key: backend.id }, ...rows);
		}

		/**
		 * The bundle's settings page.
		 *
		 * Rendered only with `view: "page"` — `plugins.bundle.config` is mounted on
		 * the package detail page, which never asks for a one-line summary.
		 */
		function CascadeCard(props) {
			var t = props.t;
			var state = props.useCascadeCard(function (snapshot) {
				return snapshot;
			});
			if (props.view !== "page") return null;
			var disabled = state.writable === false || state.saving === true;
			var shared = {
				t: t,
				state: state,
				disabled: disabled,
				props: props,
			};
			var children = [
				toggle(
					t("adopt"),
					t("adoptHint"),
					state.adopted === true,
					disabled,
					function (checked) {
						props.edit("adopt", checked ? "true" : "false");
					},
				),
				valueRow(shared, "global", "order", t("order"), t("orderHint"), t("invalidOrder")),
			];
			for (var index = 0; index < BACKENDS.length; index += 1) {
				children.push(backendSection(shared, BACKENDS[index]));
			}
			return h(
				P.SettingsForm,
				{
					labels: formLabels(t),
					state: state,
					onSave: props.save,
					onDiscard: props.discard,
				},
				...children,
			);
		}
		//#endregion

		//#region dictionaries
		/** Simplified Chinese copy (key-set source of truth). */
		var zh = {
			title: "搜索降级链",
			description: "按顺序尝试多个搜索提供方，前一个不可用时自动降级。",
			order: "降级顺序",
			orderHint: "以逗号分隔，依次尝试：tavily, querit, deepseek。留空恢复默认顺序。",
			invalidOrder: "只能填 tavily、querit、deepseek，用逗号分隔。",
			adopt: "接管网页搜索",
			adoptHint: "启用后，本插件在加载时把「设置 → 网页搜索」的提供方指向降级链，避免被该页面覆盖。改动在重启后生效。",
			enabled: "启用",
			enabledHint: "关闭后跳过该后端，保留它的密钥配置。",
			disabledTag: "已跳过",
			endpoint: "接口地址",
			endpointHint: "留空恢复默认地址。",
			credentialRef: "密钥名称",
			credentialRefHint: "凭据库中的引用名，不是密钥本身；字母或下划线开头，只含字母、数字、下划线。",
			apiKey: "密钥",
			apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
			apiKeySet: "已配置密钥。",
			apiKeyUnset: "未配置密钥，该后端会被跳过。",
			apiKeyLoading: "正在读取密钥状态…",
			apiKeyUnknown: "密钥状态暂时无法确认。若刚保存，密钥可能已写入；请勿盲目重复覆盖。",
			timeoutMs: "超时（毫秒）",
			timeoutMsHint: "1～600000 的整数；单次请求的等待上限，超时后降级到下一个后端。",
			depth: "检索深度",
			depthHint: "tavily-proxy 的 search_depth：basic 或 advanced。",
			tavilyHint: "自建代理，本机常驻，按密钥池轮换，单次调用不额外计费。",
			queritHint: "第三方检索，按账号额度计费。",
			deepseekHint: "DeepSeek 官方 Search API，按成功请求计费（5 元 / 1000 次），因此默认放在最后。",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidNumber: "请填 1～600000 的整数；留空表示使用默认值。",
			invalidText: "文本格式不正确：接口须为不含用户名密码的 http/https 地址，检索深度只能是 basic 或 advanced；留空恢复默认。",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
		};

		/** English copy, checked complete against the zh key set. */
		var en = {
			title: "Search cascade",
			description: "Try several search providers in order, falling through when one is unavailable.",
			order: "Fallback order",
			orderHint: "Comma-separated, tried left to right: tavily, querit, deepseek. Leave blank for the default order.",
			invalidOrder: "Use only tavily, querit and deepseek, separated by commas.",
			adopt: "Take over web search",
			adoptHint:
				"On load, point the web search provider at this cascade so a save on that page cannot displace it. Takes effect on restart.",
			enabled: "Enabled",
			enabledHint: "When off, this backend is skipped; its key stays configured.",
			disabledTag: "Skipped",
			endpoint: "Endpoint",
			endpointHint: "Leave blank to use the default address.",
			credentialRef: "Credential name",
			credentialRefHint: "A credential-store name, not the key itself. Start with a letter or underscore; use only letters, digits and underscores.",
			apiKey: "API key",
			apiKeyHint: "Stored outside the settings file. Leave blank to keep the current key.",
			apiKeySet: "A key is configured.",
			apiKeyUnset: "No key is configured, so this backend is skipped.",
			apiKeyLoading: "Reading key status…",
			apiKeyUnknown: "Key status is unavailable. If just saved, it may have been stored; do not blindly overwrite it.",
			timeoutMs: "Timeout (ms)",
			timeoutMsHint: "Integer from 1 to 600000; on timeout the cascade moves on.",
			depth: "Search depth",
			depthHint: "tavily-proxy's search_depth: basic or advanced.",
			tavilyHint: "Self-hosted proxy on this machine, key-pool rotation, no per-call billing.",
			queritHint: "Third-party retrieval, billed against an account quota.",
			deepseekHint:
				"The official DeepSeek Search API, billed per successful call (5 CNY / 1000 searches), so it goes last.",
			overridden: "Overridden",
			reset: "Reset",
			invalidNumber: "Enter an integer from 1 to 600000; leave blank for the default.",
			invalidText: "Use an http/https endpoint without embedded credentials and search depth basic or advanced; leave blank for the default.",
			readOnly: "Settings are read-only in this deployment.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "This deployment rejected these values; they are kept for correction.",
		};
		//#endregion

		//#region plugin
		/** Required services (cordis fiber inject). */
		var inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

		/**
		 * Mount the cascade settings page on the package detail page.
		 *
		 * Gated on `configForms.whileServed`: the page only appears once the Host
		 * actually serves this plugin's settings namespace, so a deployment where
		 * the Host half is absent shows no trace of it.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			var t = ctx.locale.bind(NS);
			ctx.effect(
				function () {
					return ctx.locale.register(NS, { zh: zh, en: en });
				},
				"cascade-search: dictionaries",
			);

			ctx.effect(
				function () {
					return ctx.configForms.whileServed([ENTRY_NS], function () {
						// Own the controller only while the Host actually serves this
						// entry. Never perform startup credential reads for an absent UI.
						var card = new CascadeCardController(ctx.configForms.get(ENTRY_NS), ctx);
						var offInvalidations = ctx.remote.$on("credentials/reference-updated", function (ref) {
							card.refreshCredential(ref);
						});
						var disposeSlot = ctx.slots.inject("plugins.bundle.config", function () {
							return ctx.slots.register(
								{
									name: "plugins.bundle.config",
									key: PACKAGE_NAME,
									locale: NS,
									inject: function () {
										return card.inject();
									},
								},
								CascadeCard,
							);
						});
						return function () {
							offInvalidations?.();
							disposeSlot();
							return card.dispose();
						};
					});
				},
				"cascade-search: settings page",
			);
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
