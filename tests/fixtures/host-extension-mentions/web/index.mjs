export function activate(api) {
  for (const sourceId of ["two-step", "multi"]) {
    api.mentions.registerPicker(sourceId, (root, picker) => {
      let step = 1;
      let generation = 0;
      let timer;
      let selected = new Set();
      let rows = [];
      let highlight = 0;
      root.classList.add("mention-demo");
      root.innerHTML = `<header><button class="back" aria-label="返回">‹</button><strong>${sourceId === "multi" ? "多选提及" : "两步选择"}</strong><span class="step">选择项目</span><button class="close" aria-label="关闭">×</button></header><div class="chips" hidden></div><input aria-label="搜索" placeholder="按名称搜索项目" /><p role="status"></p><div class="results" role="listbox"></div><footer><span>↑ ↓ 选择 · Enter 确认 · Esc 返回</span><button class="insert" hidden>插入所选提及</button></footer>`;
      const search = root.querySelector("input");
      const status = root.querySelector("[role=status]");
      const results = root.querySelector(".results");
      const chips = root.querySelector(".chips");
      const insert = root.querySelector(".insert");
      const invoke = (method, params = {}) =>
        api.backend.invoke(method, { requestId: picker.requestId, ...params });
      const cancel = () => {
        clearTimeout(timer);
        generation++;
        void invoke("mentions/cancel").catch(() => {});
      };
      const paint = () => {
        results.replaceChildren();
        rows.forEach((item, index) => {
          const button = document.createElement("button");
          button.setAttribute("role", "option");
          button.setAttribute(
            "aria-selected",
            String(selected.has(item.itemId) || index === highlight),
          );
          button.textContent = `${step === 2 && sourceId === "multi" ? (selected.has(item.itemId) ? "☑ " : "☐ ") : ""}${item.label}${step === 1 ? "　›" : ""}`;
          button.onclick = () => choose(item);
          results.append(button);
        });
        insert.hidden = step !== 2 || sourceId !== "multi";
        insert.disabled = selected.size === 0;
      };
      const choose = (item) => {
        if (step === 1) {
          cancel();
          step = 2;
          search.value = "";
          search.placeholder = "搜索项目内的条目";
          root.querySelector(".step").textContent = "选择条目";
          chips.hidden = false;
          chips.replaceChildren();
          const chip = document.createElement("button");
          chip.textContent = `${item.label} ×`;
          chip.onclick = back;
          chips.append(chip);
          void load();
          search.focus();
        } else if (sourceId === "multi") {
          if (selected.has(item.itemId)) selected.delete(item.itemId);
          else selected.add(item.itemId);
          paint();
        } else picker.insert([item]);
      };
      const back = () => {
        if (step === 1) {
          picker.close();
          return;
        }
        cancel();
        step = 1;
        selected.clear();
        search.value = "";
        search.placeholder = "按名称搜索项目";
        chips.hidden = true;
        root.querySelector(".step").textContent = "选择项目";
        void load();
        search.focus();
      };
      const load = async () => {
        const current = ++generation;
        rows = [];
        paint();
        status.textContent = step === 1 ? "正在加载项目，请稍候…（约 15 秒）" : "正在搜索…";
        try {
          if (step === 2) {
            const data = await invoke("picker/items");
            if (picker.signal.aborted || current !== generation) return;
            rows = data.items.filter((item) =>
              item.label.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
            );
          } else {
            let cursor;
            while (!picker.signal.aborted && current === generation) {
              const data = await invoke("mentions/search", {
                sourceId,
                query: search.value,
                limit: 20,
                ...(cursor ? { cursor } : {}),
              });
              if (picker.signal.aborted || current !== generation) return;
              if (data.items) {
                rows = data.items;
                break;
              }
              cursor = data.pending.cursor;
              await new Promise((resolve) => {
                timer = setTimeout(resolve, data.pending.retryAfterMs);
              });
            }
          }
          if (picker.signal.aborted || current !== generation) return;
          highlight = 0;
          status.textContent = rows.length ? `共 ${rows.length} 项` : "没有符合条件的条目";
          paint();
        } catch {
          if (picker.signal.aborted || current !== generation) return;
          status.textContent = "加载失败，请重试。";
          const retry = document.createElement("button");
          retry.textContent = "重试";
          retry.onclick = () => void load();
          results.replaceChildren(retry);
        }
      };
      root.querySelector(".back").onclick = back;
      root.querySelector(".close").onclick = picker.close;
      insert.onclick = () => picker.insert(rows.filter((item) => selected.has(item.itemId)));
      search.value = picker.initialQuery;
      search.oninput = () => {
        cancel();
        timer = setTimeout(() => void load(), 250);
      };
      root.addEventListener(
        "keydown",
        (event) => {
          if (event.isComposing) return;
          if (event.key === "Escape" && step === 2) {
            event.preventDefault();
            event.stopPropagation();
            back();
          }
          if (["ArrowDown", "ArrowUp"].includes(event.key) && rows.length) {
            event.preventDefault();
            highlight =
              (highlight + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
            paint();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (rows[highlight]) choose(rows[highlight]);
          }
        },
        { signal: picker.signal },
      );
      picker.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          generation++;
        },
        { once: true },
      );
      void load();
      return () => {
        clearTimeout(timer);
        generation++;
      };
    });
  }
}
