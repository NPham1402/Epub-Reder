"use strict";

/* ============================ Claude Code Simulation Engine ===================== */
// Authentic 1:1 Replica of Claude Code as a VS Code Editor Tab (Matching Developer Screenshots):
// 1. Dual-Pane Split Editor:
//    - Primary editor pane on the left (showing code / reader / canvas.json)
//    - Claude Code editor tab pane on the right (with tabs: Phân trình ký dự án, frmPersonnelSocialInsura..., Claude Code)
// 2. Multi-Session Tab Management:
//    - Switch seamlessly between active debugging sessions, workflow approval, and home welcome screen
// 3. Exact UI Elements:
//    - Claude Code terracotta 8-ray sunburst asterisks
//    - 8-bit retro pixel mascot on home tab
//    - Subheader with session title and clock / chat icons
//    - User message bubbles, Thought accordions, Read tools, Code blocks, Prose explanations
//    - Floating docked card with orange border #b1685b, mic button, and active file context tag (canvas.json)
// 4. Stealth EPUB Reader:
//    - Typing /read or /next streams real book text camouflaged inside live code changes and MSBuild logs

const aiChat = {
  isOpen: false,
  isGenerating: false,
  isMaximized: false,
  model: "sonnet-5",
  activeSessionId: "social",
  container: null,
  msgList: null,
  scrollBody: null,
  inputEl: null,
  sendBtn: null,
  sessionTitleEl: null,
  streamTimer: null,
  readIndex: 0,

  sessions: {
    workflow: {
      id: "workflow",
      title: "Phân trình ký dự án & hợp đồng thanh lý...",
      tabLabel: "Phân trình ký dự án",
      messages: [
        {
          role: "user",
          content: "kiểm tra lại quy trình phân trình ký dự án xem có bị sót điều kiện khi ký số online ko"
        },
        {
          role: "assistant",
          thoughtTime: "6s",
          thoughtText: "Kiểm tra module eBOSS.Modules.Signature.Api và luồng phê duyệt phân trình ký điện tử.",
          toolSteps: [
            {
              type: "read",
              file: "D:\\eBOSS Projects\\eBOSS_Company\\EDT\\eBOSS.Modules.Signature.Api\\WorkflowEngine.cs",
              lines: "lines 45-88"
            },
            {
              type: "prose",
              text: "Đã kiểm tra hàm <code>ValidateSignatureWorkflow()</code>: điều kiện kiểm tra CA token và HSM signing đã được bao bọc đầy đủ trong transaction scope, không còn trường hợp bypass khi ký hàng loạt."
            }
          ]
        }
      ]
    },
    social: {
      id: "social",
      title: "frmPersonnelSocialInsuranceFollow code r...",
      tabLabel: "frmPersonnelSocialInsura...",
      messages: [
        {
          role: "user",
          content: `ý là nâng số thứ tự lên đó\n* Nếu chuỗi không có chữ số ở cuối (trường hợp là, không nên xảy ra), giữ nguyên không đổi để tránh lặp vô hạn.\n\nKhác với tính năng "-01/-02" bạn đã bảo bỏ: cái này không thêm khách hàng, không thêm dấu gạch ngang — chỉ đơn thuần đẩy số thứ tự sẵn có lên cho tới khi hết trùng. Nó chỉ là lưới an toàn chạy đúng lúc Lưu, không hiện số mới cho bạn thấy trước khi bấm Lưu.\n\nChỗ này không cần đổi độ dài cột — vì không thêm ký tự nào, chỉ thay đổi các chữ số đã có sẵn trong đúng khuôn 11 ký tự cũ.\n\nForm thanh lý (frmCustomerServicesContractLiquidation.vb) có khả năng gặp đúng lỗi tương tự vì cũng dùng ConfigAutoToBuilder y hệt. Bạn muốn tôi thêm luôn cơ chế này cho form đó không?`
        },
        {
          role: "user",
          content: `vậy tại sao form hợp đồng cũ nó lại hiểu là tôi đã sai từ đầu`
        },
        {
          role: "assistant",
          thoughtTime: "18s",
          thoughtText: "Phân tích cơ chế CheckBeforeSave() trong form cũ so với logic tự động tăng số thứ tự của Core.",
          toolSteps: [
            {
              type: "prose",
              text: `Không phải form cũ "hiểu" gì hơn — nó xử lý theo cách khác hẳn, và tôi vừa xóa mất cách đó của bạn hồi nãy mà không giải thích rõ hệ quả.<br><br>Form gốc (<code>CheckBeforeSave()</code>) mà tôi đã xóa theo yêu cầu "xóa đi ko có tác dụng" không tự động sinh số gì cả — nó chỉ chặn lại và bắt bạn tự sửa tay:`
            },
            {
              type: "code-block",
              lang: "vb",
              code: `Private Function CheckBeforeSave() As Boolean\n    ' đếm xem có hợp đồng nào khác trùng phần số TRƯỚC dấu "/" không\n    If SqlValue.ToInteger > 0 AndAlso ucContractID.DataHasChanged Then\n        If vOperationInfo.ShowMessage("CustomerServicesContractExist", "", ucContractID.Value) Then\n            Return False ' hủy lưu, bắt người dùng tự đổi số\n        End If\n    End If\n    \n    Return True\nEnd Function`
            },
            {
              type: "prose",
              text: `Tức là nó <strong>không đoán số mới giúp bạn</strong> — nó chỉ phát hiện trùng rồi hiện thông báo, và bắt chính bạn tự gõ lại một số khác, không cho lưu cho tới khi bạn tự sửa. Đây là kiểu "chặn rồi để người xử lý", khác hẳn kiểu "tự động thay thế" mà Core đang làm (và bị lỗi ra số y hệt).<br><br><strong>Vì sao form gốc không dính lỗi này:</strong> hai lý do chính:<br><br>1. <strong>Nó không dùng cơ chế tự sinh số kiểu <code>XXYYMMXXXX</code> của Core</strong> — số hợp đồng bên Marketing có dạng có dấu <code>/</code> (ví dụ <code>A01123/01</code>), phần trước <code>/</code> là người dùng tự nhập hoặc theo quy ước khác, không phải Core tự dò MAX+1. Nên nó không có tình huống "hai dòng cùng lúc dò MAX ra cùng một số" như kiểu số tự động của mình.`
            }
          ]
        }
      ]
    },
    home: {
      id: "home",
      title: "Untitled",
      tabLabel: "Claude Code",
      messages: []
    }
  },

  init() {
    this.container = document.querySelector("#ai-sidebar");
    this.msgList = document.querySelector("#ai-messages");
    this.scrollBody = document.querySelector("#claude-scroll-body");
    this.inputEl = document.querySelector("#ai-prompt-input");
    this.sendBtn = document.querySelector("#ai-send-btn");
    this.sessionTitleEl = document.querySelector("#ai-ws-pill");

    if (!this.container) return;

    // Split buttons on left editor tab bar
    const splitClaudeBtn = document.querySelector("#btn-split-claude");
    if (splitClaudeBtn) {
      splitClaudeBtn.addEventListener("click", () => this.toggle());
    }
    const splitEdBtn = document.querySelector("#btn-split-editor");
    if (splitEdBtn) {
      splitEdBtn.addEventListener("click", () => this.toggle());
    }

    // Toggle button in titlebar & Activity Bar
    const toggleBtn = document.querySelector("#btn-toggle-chat");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => this.toggle());
    }
    const abChat = document.querySelector("#ab-chat");
    if (abChat) {
      abChat.addEventListener("click", () => this.toggle());
    }

    // Close button on tab bar
    const closeBtn = document.querySelector("#ai-close-chat");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.toggle(false));
    }

    // Maximize / Restore button
    const viewToggle = document.querySelector("#ai-view-toggle");
    if (viewToggle) {
      viewToggle.addEventListener("click", () => this.toggleMaximize());
    }

    // New session tab button
    const newChatBtn = document.querySelector("#ai-new-chat");
    if (newChatBtn) {
      newChatBtn.addEventListener("click", () => this.createNewSession());
    }
    const newTabBtn = document.querySelector("#ai-new-tab-btn");
    if (newTabBtn) {
      newTabBtn.addEventListener("click", () => this.createNewSession());
    }

    // Model selection
    const modelSelect = document.querySelector("#ai-model-select");
    if (modelSelect) {
      modelSelect.value = this.model;
      modelSelect.addEventListener("change", (e) => {
        this.model = e.target.value;
      });
    }

    // Input submission
    if (this.inputEl) {
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.handleSubmit();
        }
      });
      this.inputEl.addEventListener("input", () => {
        this.autoGrowInput();
        if (this.sendBtn) {
          this.sendBtn.classList.toggle("active", this.inputEl.value.trim().length > 0);
        }
      });
    }

    if (this.sendBtn) {
      this.sendBtn.addEventListener("click", () => this.handleSubmit());
    }

    // Ctrl+Escape focuses / unfocuses Claude Code prompt input; Escape unfocuses
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (e.ctrlKey) {
          e.preventDefault();
          if (document.activeElement === this.inputEl) {
            this.inputEl.blur();
          } else if (this.inputEl) {
            this.inputEl.focus();
          }
        } else if (document.activeElement === this.inputEl) {
          this.inputEl.blur();
        }
      }
    });

    // Wire sash resizer
    this.initSashResizer();

    // Wire session tabs click & close delegation
    const tabsBar = document.querySelector("#claude-tabs-bar");
    if (tabsBar) {
      tabsBar.addEventListener("click", (e) => {
        const closeBtn = e.target.closest(".tab-close");
        if (closeBtn) {
          e.stopPropagation();
          const sessionKey = closeBtn.dataset.close || closeBtn.closest(".claude-tab").dataset.session;
          this.closeSession(sessionKey);
          return;
        }

        const tab = e.target.closest(".claude-tab");
        if (tab && tab.dataset.session) {
          this.switchSession(tab.dataset.session);
        }
      });
    }

    // Update context tag with active file
    this.updateContextPill();

    // Closed by default: open on demand (Ctrl+L / the star button / the
    // activity bar icon) rather than always taking half the editor group —
    // on a narrow window that left no room for the primary editor at all.
    this.isOpen = false;
    if (this.container) this.container.hidden = true;
    const sash = document.querySelector("#editor-sash");
    if (sash) sash.hidden = true;

    // Pre-render the active session so opening it later is instant.
    this.switchSession(this.activeSessionId);
  },

  initSashResizer() {
    const sash = document.querySelector("#editor-sash");
    if (!sash || !this.container) return;

    let isDragging = false;
    let startX = 0;
    let startW = 0;

    sash.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startW = this.container.offsetWidth;
      sash.classList.add("active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = startX - e.clientX;
      const nextW = Math.max(280, Math.min(window.innerWidth - 300, startW + dx));
      this.container.style.width = nextW + "px";
      this.container.style.flex = `0 0 ${nextW}px`;
      if (window.reader && window.reader.ed) window.reader.ed.layout();
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        sash.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (window.reader && window.reader.ed) window.reader.ed.layout();
      }
    });
  },

  toggle(force) {
    if (force !== undefined) this.isOpen = force;
    else this.isOpen = !this.isOpen;

    if (this.container) {
      this.container.hidden = !this.isOpen;
    }
    const sash = document.querySelector("#editor-sash");
    if (sash) sash.hidden = !this.isOpen;

    const toggleBtn = document.querySelector("#btn-toggle-chat");
    if (toggleBtn) toggleBtn.classList.toggle("active", this.isOpen);

    const abChat = document.querySelector("#ab-chat");
    if (abChat) abChat.classList.toggle("active", this.isOpen);

    const starBtn = document.querySelector("#btn-split-claude");
    if (starBtn) starBtn.classList.toggle("active", this.isOpen);

    if (window.reader && window.reader.ed) {
      setTimeout(() => window.reader.ed.layout(), 50);
    }

    if (this.isOpen && this.inputEl) {
      setTimeout(() => this.inputEl.focus(), 120);
    }
  },

  toggleMaximize() {
    this.isMaximized = !this.isMaximized;
    if (this.container) {
      this.container.classList.toggle("maximized", this.isMaximized);
    }
    const btn = document.querySelector("#ai-view-toggle");
    if (btn) {
      btn.className = `ed-act-btn codicon ${this.isMaximized ? "codicon-screen-normal" : "codicon-screen-full"}`;
      btn.title = this.isMaximized ? "Restore Split View (Alt+V)" : "Maximize Tab (Alt+V)";
    }
    if (window.reader && window.reader.ed) {
      setTimeout(() => window.reader.ed.layout(), 50);
    }
  },

  switchSession(sessionId) {
    if (!this.sessions[sessionId]) return;
    this.activeSessionId = sessionId;

    // Update active tab in tabs bar
    const tabsBar = document.querySelector("#claude-tabs-bar");
    if (tabsBar) {
      tabsBar.querySelectorAll(".claude-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.session === sessionId);
      });
    }

    this.renderSession(sessionId);
    if (this.inputEl) this.inputEl.focus();
  },

  createNewSession() {
    const id = "session_" + Date.now();
    this.sessions[id] = {
      id: id,
      title: "Untitled",
      tabLabel: "Claude Code",
      messages: []
    };

    // Add tab element
    const tabsBar = document.querySelector("#claude-tabs-bar");
    if (tabsBar) {
      const tabEl = document.createElement("div");
      tabEl.className = "tab claude-tab";
      tabEl.dataset.session = id;
      tabEl.title = "New Claude Code Tab";
      tabEl.innerHTML = `
        <span class="claude-tab-icon">
          <svg class="claude-brand-asterisk" width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" stroke="#d97757" stroke-width="2.8" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="tab-name">Claude Code</span>
        <span class="tab-close codicon codicon-close" data-close="${id}"></span>
      `;
      tabsBar.appendChild(tabEl);
    }

    this.switchSession(id);
  },

  closeSession(sessionId) {
    delete this.sessions[sessionId];
    const tabsBar = document.querySelector("#claude-tabs-bar");
    if (tabsBar) {
      const tabEl = tabsBar.querySelector(`.claude-tab[data-session="${sessionId}"]`);
      if (tabEl) tabEl.remove();
    }

    const remaining = Object.keys(this.sessions);
    if (remaining.length === 0) {
      this.toggle(false);
    } else if (this.activeSessionId === sessionId) {
      this.switchSession(remaining[remaining.length - 1]);
    }
  },

  renderSession(sessionId) {
    const session = this.sessions[sessionId];
    if (!session || !this.msgList) return;

    if (this.sessionTitleEl) {
      this.sessionTitleEl.textContent = session.title;
    }

    this.msgList.innerHTML = "";

    if (!session.messages || session.messages.length === 0) {
      this.renderWelcome();
      return;
    }

    // Render session messages
    session.messages.forEach(msg => {
      if (msg.role === "user") {
        const userRow = document.createElement("div");
        userRow.className = "ai-msg-row ai-msg-user";
        userRow.innerHTML = `<div class="claude-user-bubble">${this.escapeHtml(msg.content)}</div>`;
        this.msgList.appendChild(userRow);
      } else if (msg.role === "assistant") {
        this.renderAssistantNode(msg);
      }
    });

    this.scrollToBottom();
  },

  renderAssistantNode(msg) {
    const aiNode = document.createElement("div");
    aiNode.className = "ai-msg-row ai-msg-assistant";

    let toolsHtml = "";

    // Thought accordion
    if (msg.thoughtText) {
      toolsHtml += `
        <div class="claude-thought-box">
          <div class="claude-thought-header">
            <span class="claude-bullet gray">●</span>
            <span class="claude-thought-title">Thought for ${msg.thoughtTime || "18s"}</span>
            <span class="codicon codicon-chevron-down claude-thought-caret"></span>
          </div>
          <div class="claude-thought-body">${this.escapeHtml(msg.thoughtText)}</div>
        </div>
      `;
    }

    // Tool steps
    if (msg.toolSteps && msg.toolSteps.length) {
      msg.toolSteps.forEach(step => {
        if (step.type === "prose") {
          toolsHtml += `
            <div style="margin: 4px 0 6px;">
              <span class="claude-bullet gray">●</span>
              <span>${step.text}</span>
            </div>
          `;
        } else if (step.type === "read") {
          toolsHtml += `
            <div class="claude-tool-step">
              <span class="claude-bullet">●</span>
              <span class="claude-tool-name">Read</span>
              <span class="claude-file-path">${this.escapeHtml(step.file)}</span>
              <span class="claude-file-lines">(${this.escapeHtml(step.lines)})</span>
            </div>
          `;
        } else if (step.type === "code-block") {
          toolsHtml += `
            <div class="claude-term-box" style="margin: 6px 0 8px 15px; background: #16171a; border-color: #383b44;">
              <pre style="margin:0; font-family: Consolas, monospace; font-size: 11.5px; line-height: 1.5; color: #dcdde2;">${this.highlightCode(step.code, step.lang)}</pre>
            </div>
          `;
        }
      });
    }

    aiNode.innerHTML = `
      <div class="claude-assistant-wrap">
        ${toolsHtml}
      </div>
    `;

    this.msgList.appendChild(aiNode);
  },

  highlightCode(code, lang) {
    let escaped = this.escapeHtml(code);
    if (lang === "vb") {
      escaped = escaped
        .replace(/\b(Private|Public|Function|Sub|As|Boolean|Integer|String|If|Then|End|Return|AndAlso)\b/g, '<span class="claude-kw">$1</span>')
        .replace(/('[\s\S]*?$)/gm, '<span style="color:#6a9955">$1</span>')
        .replace(/(&quot;[\s\S]*?&quot;)/g, '<span class="claude-str">$1</span>');
    }
    return escaped;
  },

  renderWelcome() {
    if (!this.msgList) return;
    this.msgList.innerHTML = `
      <div class="claude-empty-screen">
        <div class="claude-pixel-mascot">
          <svg width="36" height="30" viewBox="0 0 28 23" fill="#d97757" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 0h24v6h-24zM0 6h5v3h-5zM8 6h13v3h-13zM24 6h4v3h-4zM0 9h28v2h-28zM2 11h24v6h-24zM2 17h3v1h-3zM7 17h3v1h-3zM18 17h3v1h-3zM24 17h2v1h-2zM2 18h3v5h-3zM8 18h2v5h-2zM19 18h2v5h-2zM24 18h2v5h-2z"/>
          </svg>
        </div>
        <h2 class="claude-empty-title">Ready to code?</h2>
        <p class="claude-empty-subtitle">Let's write something worth deploying.</p>

        <div class="claude-announce-card">
          <div class="claude-announce-head">
            <span class="claude-announce-title">Introducing Opus 5.5</span>
            <span class="claude-announce-close" title="Dismiss">×</span>
          </div>
          <div class="claude-announce-body">
            Opus 5.5 is now your default model and it draws down usage faster than Sonnet 5. Switch anytime with <code class="claude-inline-tag">/model</code>.
          </div>
        </div>
      </div>
    `;
  },

  autoGrowInput() {
    if (!this.inputEl) return;
    this.inputEl.style.height = "auto";
    const nextH = Math.min(this.inputEl.scrollHeight, 140);
    this.inputEl.style.height = nextH + "px";
  },

  updateContextPill(fileName) {
    const tag = document.querySelector("#ai-active-file-tag");
    if (!tag) return;
    const name = fileName || (typeof state !== "undefined" && state.current ? state.current.fileName : "canvas.json");
    const ext = name.split(".").pop().toLowerCase();
    const icon = ext === "json" ? "codicon-json" : (ext === "vb" || ext === "cs" || ext === "ts" || ext === "js") ? "codicon-file-code" : "codicon-file";
    tag.innerHTML = `<span class="codicon ${icon}"></span> ${this.escapeHtml(name)} <span class="claude-tag-close">×</span>`;
  },

  handleSubmit() {
    if (this.isGenerating || !this.inputEl) return;
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;
    this.inputEl.value = "";
    if (this.sendBtn) this.sendBtn.classList.remove("active");
    this.autoGrowInput();
    this.sendPrompt(prompt);
  },

  sendPrompt(prompt) {
    if (this.isGenerating) return;

    // Remove empty screen if present
    const emptyScreen = this.msgList.querySelector(".claude-empty-screen");
    if (emptyScreen) emptyScreen.remove();

    const session = this.sessions[this.activeSessionId];
    if (!session) return;

    // Update session title if first prompt in empty session
    if (session.messages.length === 0) {
      session.title = prompt.length > 40 ? prompt.slice(0, 38) + "..." : prompt;
      if (this.sessionTitleEl) this.sessionTitleEl.textContent = session.title;
      const tabEl = document.querySelector(`.claude-tab[data-session="${this.activeSessionId}"] .tab-name`);
      if (tabEl) tabEl.textContent = session.title;
    }

    // Append User Message
    session.messages.push({
      role: "user",
      content: prompt
    });

    const userRow = document.createElement("div");
    userRow.className = "ai-msg-row ai-msg-user";
    userRow.innerHTML = `<div class="claude-user-bubble">${this.escapeHtml(prompt)}</div>`;
    this.msgList.appendChild(userRow);
    this.scrollToBottom();

    // Prepare Assistant response
    this.isGenerating = true;
    if (this.sendBtn) this.sendBtn.classList.add("disabled");

    const replyData = this.generateTechnicalResponse(prompt);

    const aiId = "ai_" + Date.now();
    const aiNode = document.createElement("div");
    aiNode.className = "ai-msg-row ai-msg-assistant";
    aiNode.id = aiId;

    let toolsHtml = "";
    if (replyData.thought) {
      toolsHtml += `
        <div class="claude-thought-box" id="th_${aiId}">
          <div class="claude-thought-header">
            <span class="claude-bullet gray">●</span>
            <span class="claude-thought-title">Thought for ${replyData.thinkTime || "7s"}</span>
            <span class="codicon codicon-chevron-down claude-thought-caret"></span>
          </div>
          <div class="claude-thought-body">${this.escapeHtml(replyData.thought)}</div>
        </div>
      `;
    }
    if (replyData.insight) {
      toolsHtml += `
        <div style="margin: 4px 0 6px;">
          <span class="claude-bullet gray">●</span>
          <span>${this.escapeHtml(replyData.insight)}</span>
        </div>
      `;
    }
    if (replyData.read) {
      toolsHtml += `
        <div class="claude-tool-step">
          <span class="claude-bullet">●</span>
          <span class="claude-tool-name">Read</span>
          <span class="claude-file-path">${this.escapeHtml(replyData.read.file)}</span>
          <span class="claude-file-lines">(${this.escapeHtml(replyData.read.lines)})</span>
        </div>
      `;
    }
    if (replyData.edit) {
      const oldCols = (replyData.edit.oldLines || []).map((l, i) => `
        <div class="${l.type === 'del' ? 'claude-diff-line del' : l.type === 'hatch' ? 'claude-diff-line hatch' : 'claude-diff-line'}">
          <span class="claude-diff-num">${l.num || i + 109}</span>
          <span>${l.code}</span>
        </div>
      `).join("");

      const newCols = (replyData.edit.newLines || []).map((l, i) => `
        <div class="${l.type === 'add' ? 'claude-diff-line add' : 'claude-diff-line'}">
          <span class="claude-diff-num">${l.num || i + 109}</span>
          <span>${l.code}</span>
        </div>
      `).join("");

      toolsHtml += `
        <div class="claude-tool-step claude-edit-step">
          <div class="claude-edit-head">
            <span class="claude-bullet">●</span>
            <span class="claude-tool-name">Edit</span>
            <span class="claude-file-path">${this.escapeHtml(replyData.edit.file)}</span>
          </div>
          <div class="claude-edit-badge">${this.escapeHtml(replyData.edit.change || "Added 1 line")}</div>
          <div class="claude-diff-card">
            <div class="claude-diff-col claude-diff-old">${oldCols}</div>
            <div class="claude-diff-col claude-diff-new">${newCols}</div>
          </div>
        </div>
      `;
    }
    if (replyData.secondThought) {
      toolsHtml += `
        <div style="margin: 4px 0 6px;">
          <span class="claude-bullet gray">●</span>
          <span style="color: #8e9099; font-weight: 500;">${this.escapeHtml(replyData.secondThought)}</span>
        </div>
      `;
    }
    if (replyData.terminal) {
      toolsHtml += `
        <div class="claude-tool-step claude-cmd-step">
          <div class="claude-cmd-head">
            <span class="claude-bullet">●</span>
            <span class="claude-tool-name">${this.escapeHtml(replyData.terminal.type || "PowerShell")}</span>
            <span class="claude-cmd-title">${this.escapeHtml(replyData.terminal.title)}</span>
          </div>
          <div class="claude-term-box">
            <div class="claude-term-row in">
              <span class="claude-term-tag">IN</span>
              <span class="claude-term-cmd">${this.escapeHtml(replyData.terminal.inCmd)}</span>
            </div>
            <div class="claude-term-row out">
              <span class="claude-term-tag">OUT</span>
              <span class="claude-term-out">${this.escapeHtml(replyData.terminal.outResult)}</span>
            </div>
          </div>
        </div>
      `;
    }

    aiNode.innerHTML = `
      <div class="claude-assistant-wrap">
        ${toolsHtml}
        <div class="claude-final-prose" id="body_${aiId}"></div>
      </div>
    `;
    this.msgList.appendChild(aiNode);
    this.scrollToBottom();

    // Stream prose response
    let index = 0;
    const fullText = replyData.body;
    const bodyEl = aiNode.querySelector(`#body_${aiId}`);
    const chunkSize = 8;

    clearInterval(this.streamTimer);
    this.streamTimer = setInterval(() => {
      index += chunkSize;
      const currentSlice = fullText.slice(0, index);
      bodyEl.innerHTML = this.renderMarkdown(currentSlice) + `<span class="ai-stream-cursor">▌</span>`;
      this.scrollToBottom();

      if (index >= fullText.length) {
        clearInterval(this.streamTimer);
        this.streamTimer = null;
        this.isGenerating = false;
        bodyEl.innerHTML = this.renderMarkdown(fullText);
        if (this.sendBtn) this.sendBtn.classList.remove("disabled");

        session.messages.push({
          role: "assistant",
          content: fullText,
          thoughtText: replyData.thought,
          thoughtTime: replyData.thinkTime
        });
      }
    }, 20);
  },

  scrollToBottom() {
    if (!this.scrollBody) return;
    this.scrollBody.scrollTop = this.scrollBody.scrollHeight;
  },

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  renderMarkdown(src) {
    if (!src) return "";
    let html = src;
    html = html.replace(/`([^`\n]+)`/g, (match, code) => `<code>${this.escapeHtml(code)}</code>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/^\s*[•\-\*]\s+(.*$)/gim, '<li class="ai-li">$1</li>');
    html = html.replace(/(<li class="ai-li">.*<\/li>)/gis, '<ul class="ai-ul">$1</ul>');
    html = html.replace(/\n{2,}/g, '<div class="ai-p-gap"></div>');
    return html;
  },

  generateTechnicalResponse(prompt) {
    const q = prompt.toLowerCase();
    const curModule = typeof state !== "undefined" && state.current && state.current.chapter
      ? (typeof fileLabel === "function" ? fileLabel(state.current.chapter) : "FrmCustomerServicesContractAppendix.vb")
      : "FrmCustomerServicesContractAppendix.vb";
    const curRepo = typeof state !== "undefined" && state.current && state.current.code_name
      ? state.current.code_name
      : "eBOSS_Company";

    // 1. Stealth EPUB reader
    if (q === "/read" || q === "/next") {
      let pText = "Dữ liệu cấu hình phân hệ đã được phân giải.";
      let pNum = 1;
      let totalBlocks = 1;

      if (typeof state !== "undefined" && state.current && state.current.chapter && state.current.chapter._blocks) {
        const blocks = state.current.chapter._blocks.filter(b => b.text && b.text.trim());
        totalBlocks = Math.max(1, blocks.length);
        if (q === "/next") this.readIndex = (this.readIndex + 1) % totalBlocks;
        pNum = this.readIndex + 1;
        if (blocks[this.readIndex]) pText = blocks[this.readIndex].text;
      }

      return {
        thinkTime: "3s",
        thought: `Đang rà soát và tải phân đoạn logic #${pNum}/${totalBlocks} từ ${curModule}.`,
        insight: `Phân đoạn #${pNum} đã được nạp thành công vào bộ nhớ kiểm duyệt.`,
        read: {
          file: `D:\\eBOSS Projects\\${curRepo}\\EDT\\${curModule}`,
          lines: `lines ${100 + pNum * 5}-${120 + pNum * 5}`
        },
        edit: {
          file: `D:\\eBOSS Projects\\${curRepo}\\EDT\\${curModule}`,
          change: "Updated documentation comments & logic wrapper",
          oldLines: [
            { num: 105, type: "normal", code: `' [Internal Registry Ref #${pNum}]` },
            { num: 106, type: "del", code: `' TODO: Pending segment verification` }
          ],
          newLines: [
            { num: 105, type: "normal", code: `' [Internal Registry Ref #${pNum}]` },
            { num: 106, type: "add", code: `' Narrative: ${this.escapeHtml(pText.slice(0, 70))}...` }
          ]
        },
        secondThought: "Thought for 1s",
        terminal: {
          type: "PowerShell",
          title: `Build verification for narrative segment #${pNum} in ${curModule}`,
          inCmd: `& 'C:\\Program Files (x86)\\MSBuild\\14.0\\bin\\MSBuild.exe' 'D:\\eBOSS Projects\\${curRepo}\\eBOSS.sln' /t:Build /p:Configuration=Debug`,
          outResult: `Build Succeeded: 0 Error(s), 0 Warning(s). Elapsed: 00:00:01.42`
        },
        body: [
          `● Đã rà soát và cập nhật thành công phân đoạn dữ liệu #${pNum} / ${totalBlocks}.`,
          "",
          `Nội dung phân đoạn vừa giải nạp:`,
          `> "${pText}"`,
          "",
          `• Tiến độ hiện tại: Khối ${pNum} trên tổng số ${totalBlocks} khối.`,
          `• Gợi ý: Gõ \`/next\` hoặc nhấn Enter để Claude Code nạp và verify phân đoạn kế tiếp.`
        ].join("\n")
      };
    }

    // 2. Prefix & zero-padding resolution (from user screenshot)
    if (q.includes("pre") || q.includes("prefix") || q.includes("ddoori laij logic") || q.includes("thu lại")) {
      return {
        thinkTime: "7s",
        thought: "Đúng, tôi đang đệm cứng 7 số 0 bất kể Prefix dài bao nhiêu — sai. Sửa lại để số 0 co giãn theo đúng độ dài Prefix, giữ tổng luôn 11 ký tự.",
        insight: "Đã rà soát công thức sinh mã phụ lục: số 0 tự co lại theo độ dài Prefix.",
        read: {
          file: "D:\\eBOSS Projects\\eBOSS_Company\\EDT\\eBOSS.Application.CustomerServices\\04. CustomerServicesContract\\FrmCustomerServicesContractAppendix.vb",
          lines: "lines 109-153"
        },
        edit: {
          file: "D:\\eBOSS Projects\\eBOSS_Company\\EDT\\eBOSS.Application.CustomerServices\\04. CustomerServicesContract\\FrmCustomerServicesContractAppendix.vb",
          change: "Added 1 line",
          oldLines: [
            { num: 110, type: "normal", code: 'Dim RootKey As String = PrefixID & Format(ucRecordDate.Value, "yy")' },
            { num: 111, type: "del", code: 'Dim BaseAppendixID As String = RootKey & Strings.Right("0000000" & NextSequenceNumber.ToString(), 7)' },
            { num: 112, type: "hatch", code: '' }
          ],
          newLines: [
            { num: 110, type: "normal", code: 'Dim RootKey As String = PrefixID & Format(ucRecordDate.Value, "yy")' },
            { num: 111, type: "add", code: 'Dim SequenceDigitLength As Integer = 11 - RootKey.Length' },
            { num: 112, type: "add", code: 'Dim BaseAppendixID As String = RootKey & Strings.Right(New String("0"c, SequenceDigitLength) & NextSequenceNumber.ToString(), SequenceDigitLength)' }
          ]
        },
        secondThought: "Thought for 1s",
        terminal: {
          type: "PowerShell",
          title: "Build after fixing dynamic zero-padding for variable prefix length",
          inCmd: "& 'C:\\Program Files (x86)\\MSBuild\\14.0\\Bin\\MSBuild.exe' 'D:\\eBOSS Projects\\eBOSS_Company\\EDT\\eBOSS.Application.CustomerServices.sln' /t:Build",
          outResult: "eBOSS.Application.CustomerServices -> C:\\Users\\DOPHAM~1\\AppData\\Local\\Temp\\claude\\out\\eBOSS.Application.CustomerServices.dll"
        },
        body: [
          `• Đã sửa. Build lại qua MSBuild 14 không lỗi, nhưng chưa chạy thử trên màn hình thật.`,
          ``,
          `Chỗ sai trước đó: dòng ráp số luôn đệm cứng 7 số 0 ("0000000"), bất kể Prefix dài bao nhiêu. Nếu Prefix dài 4 ký tự thay vì 2, tổng ra 4+2+7 = 13 ký tự, lệch khỏi khuôn 11 ký tự cố định.`,
          `Đã sửa: số lượng số 0 đệm giờ tính động bằng 11 - RootKey.Length (RootKey = Prefix + năm 2 số), y hệt công thức GetNextAppendixBaseSequence đã dùng để tách số cũ ra khỏi DB. Vậy:`,
          ``,
          `• Prefix 2 ký tự -> RootKey dài 4 -> đệm 7 số -> tổng 11.`,
          `• Prefix 4 ký tự -> RootKey dài 6 -> đệm 5 số -> tổng vẫn 11.`,
          ``,
          `Tổng độ dài phần gốc luôn cố định 11 ký tự dù Prefix ngắn hay dài, đúng như bạn muốn — số 0 tự "co lại" khi Prefix dài ra.`
        ].join("\n")
      };
    }

    // 3. Default developer response
    return {
      thinkTime: "4s",
      thought: `Phân tích yêu cầu "${prompt}", rà soát các ràng buộc kiến trúc trong module ${curModule} và xây dựng giải pháp xử lý.`,
      insight: `Đã hoàn tất phân tích module ${curModule}. Cần refactor để tối ưu luồng thực thi.`,
      read: {
        file: `D:\\eBOSS Projects\\${curRepo}\\EDT\\${curModule}`,
        lines: "lines 80-125"
      },
      edit: {
        file: `D:\\eBOSS Projects\\${curRepo}\\EDT\\${curModule}`,
        change: "Modified 2 lines",
        oldLines: [
          { num: 80, type: "normal", code: '<span class="claude-kw">Public Sub</span> ProcessRequest(req <span class="claude-kw">As</span> ServiceRequest)' },
          { num: 81, type: "del", code: "  SyncLock lockObj" }
        ],
        newLines: [
          { num: 80, type: "normal", code: '<span class="claude-kw">Public Async Function</span> ProcessRequestAsync(req <span class="claude-kw">As</span> ServiceRequest) <span class="claude-kw">As Task</span>' },
          { num: 81, type: "add", code: "  Await semaphore.WaitAsync()" }
        ]
      },
      secondThought: "Thought for 1s",
      terminal: {
        type: "PowerShell",
        title: `Build verification for ${curModule}`,
        inCmd: `& 'C:\\Program Files (x86)\\MSBuild\\14.0\\bin\\MSBuild.exe' /t:Build /p:Configuration=Debug`,
        outResult: `Build succeeded. 0 Warning(s), 0 Error(s).`
      },
      body: [
        `● Đã hoàn thành phân tích và đề xuất giải pháp cho: "${prompt}".`,
        "",
        `Giải pháp kỹ thuật:`,
        `• Tách biệt Presentation Layer khỏi Execution Orchestrator để ngăn ngừa cascade failure.`,
        `• Áp dụng cơ chế non-blocking semaphore thay cho synchronous lock để tối ưu I/O.`,
        `• Mã nguồn đã được build thử nghiệm qua MSBuild không phát sinh lỗi biên dịch.`
      ].join("\n")
    };
  }
};

window.aiChat = aiChat;
document.addEventListener("DOMContentLoaded", () => aiChat.init());
