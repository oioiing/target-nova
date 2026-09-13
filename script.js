const fallbackDatasets = {
  egfr: {
    count: 1024,
    compounds: [
      ["Compound-017", 9.42, 9.17, "Live Prediction"],
      ["Compound-042", 9.17, 8.96, "Live Prediction"],
      ["Compound-006", 8.96, 8.81, "Reproduced"],
      ["Compound-031", 8.72, 8.54, "Reproduced"],
      ["Compound-089", 8.51, 8.22, "Published"],
      ["Compound-073", 8.33, 8.10, "Published"],
      ["Compound-014", 8.14, 7.91, "Demo Data"],
      ["Compound-055", 7.94, 7.68, "Demo Data"],
      ["Compound-098", 7.73, 7.42, "Demo Data"],
      ["Compound-002", 7.51, 7.22, "Demo Data"],
    ],
  },
};

let latestTask = null;
let latestResults = [];
let currentTop = 10;
let uploadedDrugs = [];

const body = document.body;
const rankTable = document.querySelector("#rankTable");
const barChart = document.querySelector("#barChart");
const histogram = document.querySelector("#histogram");
const librarySelect = document.querySelector("#librarySelect");
const modelName = document.querySelector("#modelName");
const candidateCount = document.querySelector("#candidateCount");
const topScore = document.querySelector("#topScore");
const candidateDetail = document.querySelector("#candidateDetail");
const progressFill = document.querySelector("#progressFill");
const runPercent = document.querySelector("#runPercent");
const runState = document.querySelector("#runState");
const form = document.querySelector("#screeningForm");
const csvInput = document.querySelector("#csvInput");
const csvStatus = document.querySelector("#csvStatus");

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `API request failed: ${response.status}`);
  }
  return response.json();
}

function fallbackResults() {
  return fallbackDatasets.egfr.compounds.map(([drug, tsedta, mredta, evidence], index) => ({
    rank: index + 1,
    drug,
    tsedta,
    mredta,
    affinity: tsedta,
    evidence,
    priority: tsedta >= 8.8 ? "High" : tsedta >= 8 ? "Medium" : "Watch",
    smiles: "CCOc1ccc2nc(S(N)(=O)=O)sc2c1",
    agreement: Math.round(100 - Math.abs(tsedta - mredta) * 24),
  }));
}

async function loadDatasets() {
  try {
    const datasets = await api("/api/datasets");
    librarySelect.innerHTML = datasets
      .map((dataset) => `<option value="${dataset.key}">${dataset.label} · ${dataset.count.toLocaleString()} candidates</option>`)
      .join("");
  } catch {
    runState.textContent = "Local Demo";
  }
}

function renderResults(results = latestResults) {
  const visible = results.slice(0, currentTop);
  if (!visible.length) return;

  candidateCount.textContent = (latestTask?.sequence_length ? latestTask : { top_k: visible.length }).top_k
    ? (latestTask?.candidate_count || visible.length).toLocaleString()
    : visible.length.toLocaleString();
  modelName.textContent = latestTask?.model || new FormData(form).get("model") || "TSEDTA";
  topScore.textContent = visible[0].affinity.toFixed(2);

  rankTable.innerHTML = visible.map((row) => {
    const className = row.priority === "High" ? "" : "medium";
    return `<tr data-rank="${row.rank}">
      <td>${String(row.rank).padStart(2, "0")}</td>
      <td>${row.drug}</td>
      <td>${row.affinity.toFixed(2)}</td>
      <td><span class="tag ${className}">${row.priority}</span></td>
      <td>${row.evidence}</td>
    </tr>`;
  }).join("");

  barChart.innerHTML = results.slice(0, 10).map((row) => {
    const width = Math.max(10, ((row.affinity - 6) / 4) * 100);
    return `<div class="bar-row">
      <span>${row.drug}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      <strong>${row.affinity.toFixed(2)}</strong>
    </div>`;
  }).join("");

  const bars = [18, 34, 58, 92, 120, 138, 108, 72, 45, 28, 16, 10];
  histogram.innerHTML = bars.map((height) => `<span style="height:${height}px"></span>`).join("");
  bindRows();
}

function bindRows() {
  document.querySelectorAll("#rankTable tr").forEach((row) => {
    row.addEventListener("click", () => {
      document.querySelectorAll("#rankTable tr").forEach((item) => item.classList.remove("selected"));
      row.classList.add("selected");
      const data = latestResults.find((item) => item.rank === Number(row.dataset.rank));
      if (!data) return;
      candidateDetail.innerHTML = `<span>Candidate Detail</span>
        <strong>${data.drug}</strong>
        <p>SMILES: ${data.smiles} · Rank #${data.rank} · TSEDTA ${data.tsedta.toFixed(2)} · MREDTA ${data.mredta.toFixed(2)} · Agreement ${data.agreement}%</p>
        <div class="agreement"><i style="width:${data.agreement}%"></i></div>`;
    });
  });
}

function selectedModel() {
  return new FormData(form).get("model") || "TSEDTA";
}

async function createScreening() {
  const payload = {
    targetName: document.querySelector("#targetNameInput").value || "EGFR",
    mutation: document.querySelector("#mutationInput").value || "T790M",
    proteinSequence: document.querySelector("#proteinInput").value,
    library: uploadedDrugs.length ? "uploaded" : librarySelect.value || "egfr",
    model: selectedModel(),
    topK: Number(document.querySelector("#topKInput").value || 20),
    customDrugs: uploadedDrugs,
  };
  const response = await api("/api/screenings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  latestTask = response.task;
  latestResults = response.results;
  renderResults();
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseDrugCsv(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const idIndex = headers.indexOf("drug_id");
  const nameIndex = headers.indexOf("drug_name");
  const smilesIndex = headers.indexOf("smiles");
  if (smilesIndex === -1) return [];
  return lines.slice(1).map((line, index) => {
    const cells = parseCsvLine(line);
    return {
      drug_id: idIndex >= 0 ? cells[idIndex] : `UP-${String(index + 1).padStart(3, "0")}`,
      drug_name: nameIndex >= 0 ? cells[nameIndex] : cells[idIndex] || `Uploaded-${String(index + 1).padStart(3, "0")}`,
      smiles: cells[smilesIndex],
    };
  }).filter((drug) => drug.smiles);
}

csvInput.addEventListener("change", async () => {
  const file = csvInput.files?.[0];
  uploadedDrugs = [];
  if (!file) {
    csvStatus.textContent = "可选：drug_id, drug_name, smiles";
    return;
  }
  const text = await file.text();
  uploadedDrugs = parseDrugCsv(text);
  if (!uploadedDrugs.length) {
    csvStatus.textContent = "CSV 未识别，请包含 smiles 列";
    return;
  }
  csvStatus.textContent = `已读取 ${uploadedDrugs.length} 个候选药物：${file.name}`;
});

document.querySelector("#themeToggle").addEventListener("click", (event) => {
  const isNight = body.dataset.theme === "night";
  body.dataset.theme = isNight ? "day" : "night";
  event.currentTarget.textContent = isNight ? "☾" : "☀";
});

document.querySelectorAll(".mode-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode-tabs button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

document.querySelectorAll('input[name="model"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (latestResults.length) createScreening().catch(() => renderResults());
  });
});

librarySelect.addEventListener("change", () => createScreening().catch(() => renderResults()));

document.querySelector("#top10Btn").addEventListener("click", () => {
  currentTop = 10;
  renderResults();
});

document.querySelector("#top20Btn").addEventListener("click", () => {
  currentTop = 20;
  renderResults();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runState.textContent = "Screening...";
  progressFill.style.width = "0%";
  runPercent.textContent = "0%";
  let progress = 0;
  const timer = setInterval(async () => {
    progress += 20;
    progressFill.style.width = `${progress}%`;
    runPercent.textContent = `${progress}%`;
    if (progress >= 100) {
      clearInterval(timer);
      try {
        await createScreening();
        runState.textContent = latestTask.run_mode;
      } catch (error) {
        runState.textContent = "Local Demo";
        latestResults = fallbackResults();
        renderResults();
      }
      document.querySelector("#result").scrollIntoView({ behavior: "smooth" });
    }
  }, 160);
});

document.querySelector("#exportBtn").addEventListener("click", () => {
  if (latestTask) {
    window.location.href = `/api/screenings/${latestTask.task_id}/report`;
    return;
  }
  const rows = latestResults.map((row) => `${row.rank},${row.drug},${row.affinity},${row.tsedta},${row.mredta},${row.evidence}`).join("\n");
  downloadText("target-nova-screening-demo.csv", `rank,drug,affinity,tsedta,mredta,evidence\n${rows}`);
});

document.querySelector("#downloadReport").addEventListener("click", () => {
  if (latestTask) {
    window.location.href = `/api/screenings/${latestTask.task_id}/report`;
    return;
  }
  downloadText(
    "target-nova-demo-report.txt",
    "靶智星图筛选报告\n\n任务：EGFR T790M 候选药物筛选\n运行模式：Demo Data / Computational Prediction\n主模型：TSEDTA\n第二模型：MREDTA model consensus\n\n说明：计算结果仅用于科研预筛，不能替代分子对接、结合实验或药效实验验证。"
  );
});

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function initProteinViewer() {
  if (!window.THREE) return;
  const container = document.querySelector("#proteinViewer");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(0, 0, 15);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);

  const residueObjects = [];
  const points = [];
  for (let i = 0; i < 72; i += 1) {
    const angle = i * 0.42;
    const radius = 3 + Math.sin(i * 0.18) * 0.9;
    const x = Math.cos(angle) * radius;
    const y = (i - 36) * 0.105;
    const z = Math.sin(angle) * radius;
    points.push(new THREE.Vector3(x, y, z));
    const material = new THREE.MeshStandardMaterial({
      color: i % 11 === 5 ? 0xdd6b20 : i % 7 === 0 ? 0x77b5a8 : 0xdfeee8,
      emissive: i % 11 === 5 ? 0x5f2108 : 0x173f40,
      roughness: 0.38,
      metalness: 0.2,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(i % 11 === 5 ? 0.18 : 0.12, 20, 20), material);
    sphere.position.copy(points[i]);
    sphere.userData = { residue: 72 + i, attention: (0.42 + (i % 18) / 40).toFixed(2) };
    group.add(sphere);
    residueObjects.push(sphere);
  }

  const curve = new THREE.CatmullRomCurve3(points);
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 180, 0.035, 8, false),
    new THREE.MeshStandardMaterial({ color: 0x74b4a8, emissive: 0x173f40, transparent: true, opacity: 0.88 })
  );
  group.add(tube);

  scene.add(new THREE.AmbientLight(0xffffff, 2));
  const key = new THREE.PointLight(0x9cd4c7, 2.2, 80);
  key.position.set(8, 8, 10);
  scene.add(key);
  const fill = new THREE.PointLight(0xdd6b20, 1.4, 80);
  fill.position.set(-7, -4, 9);
  scene.add(fill);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let paused = false;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function pointerMove(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    if (dragging) {
      group.rotation.y += (event.clientX - lastX) * 0.008;
      group.rotation.x += (event.clientY - lastY) * 0.008;
      lastX = event.clientX;
      lastY = event.clientY;
    }
  }

  renderer.domElement.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
  });
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("wheel", (event) => {
    event.preventDefault();
    camera.position.z = Math.max(8, Math.min(22, camera.position.z + event.deltaY * 0.01));
  });
  renderer.domElement.addEventListener("click", () => {
    paused = !paused;
  });
  document.querySelector("#pause3d").addEventListener("click", () => {
    paused = !paused;
    document.querySelector("#pause3d").textContent = paused ? "继续旋转" : "暂停旋转";
  });

  function animate() {
    requestAnimationFrame(animate);
    if (!paused && !dragging && !body.classList.contains("motion-paused") && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) group.rotation.y += 0.004;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(residueObjects)[0];
    if (hit) {
      document.querySelector("#residueLabel").textContent = `Residue ${hit.object.userData.residue} · attention ${hit.object.userData.attention}`;
    }
    renderer.render(scene, camera);
  }

  window.addEventListener("resize", () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  animate();
}

async function boot() {
  latestResults = fallbackResults();
  renderResults();
  await loadDatasets();
  await createScreening().catch(() => renderResults());
}

function initPageMotion() {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const toggle = document.querySelector("#motionToggle");
  const header = document.querySelector(".site-header");
  const stage = document.querySelector(".protein-stage");
  let paused = preference.matches;
  let frame = 0;

  document.querySelectorAll(".primary-link, .primary-button, .secondary-link").forEach((button) => {
    const label = button.textContent;
    const viewport = document.createElement("span");
    viewport.className = "button-window";
    const reel = document.createElement("span");
    reel.className = "button-reel";
    const original = document.createElement("span");
    original.textContent = label;
    const duplicate = original.cloneNode(true);
    duplicate.setAttribute("aria-hidden", "true");
    reel.append(original, duplicate);
    viewport.append(reel);
    button.replaceChildren(viewport);
  });

  const reveals = document.querySelectorAll(".hero-copy, .hero-photo, .research-heading, .molecule-photo, .section-heading, .workflow article, .model-grid article, .control-panel, .run-panel, .ranking-panel, .chart-panel, .dataset-row, .report-card");
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });
  reveals.forEach((element, index) => {
    element.classList.add("reveal");
    element.style.setProperty("--reveal-delay", `${index % 3 * 75}ms`);
    observer.observe(element);
  });
  body.classList.add("motion-ready");

  const paragraphs = [...document.querySelectorAll(".hero-text, .models .section-heading p, .data .section-heading p, .report-card p")];
  paragraphs.forEach((paragraph) => {
    const text = paragraph.textContent;
    paragraph.setAttribute("aria-label", text);
    const words = Array.from(text).map((letter) => {
      const span = document.createElement("span");
      span.className = "scroll-word";
      span.textContent = letter;
      span.setAttribute("aria-hidden", "true");
      return span;
    });
    paragraph.replaceChildren(...words);
  });

  function update() {
    frame = 0;
    const height = window.innerHeight;
    const travel = document.documentElement.scrollHeight - height;
    header.style.setProperty("--page-progress", travel > 0 ? Math.min(1, window.scrollY / travel) : 0);
    header.classList.toggle("is-scrolled", window.scrollY > 60);
    if (paused || preference.matches) return;
    stage.style.setProperty("--stage-y", `${Math.min(window.scrollY * .075, 60)}px`);
    stage.style.setProperty("--stage-turn", `${-3 + Math.min(window.scrollY / height, 1) * 6}deg`);
    paragraphs.forEach((paragraph) => {
      const rect = paragraph.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (height * .94 - rect.top) / (height * .4)));
      [...paragraph.children].forEach((word, index) => {
        word.style.setProperty("--word-opacity", progress >= index / paragraph.children.length ? "1" : ".25");
      });
    });
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function syncMotion() {
    body.classList.toggle("motion-paused", paused);
    toggle.textContent = paused ? "开启动效" : "暂停动效";
    toggle.setAttribute("aria-pressed", String(paused));
    document.documentElement.style.scrollBehavior = paused ? "auto" : "";
    schedule();
  }

  toggle.addEventListener("click", () => { paused = !paused; syncMotion(); });
  preference.addEventListener("change", () => { paused = preference.matches; syncMotion(); });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  syncMotion();
}

boot();
initPageMotion();
initProteinViewer();