from __future__ import annotations

import csv
import io
import json
import mimetypes
import os
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "target_nova.db"))


DATASETS: dict[str, dict[str, Any]] = {
    "egfr": {
        "label": "Demo EGFR Library",
        "count": 1024,
        "compounds": [
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
            ["Compound-061", 7.28, 7.08, "Demo Data"],
            ["Compound-079", 7.06, 6.81, "Demo Data"],
        ],
    },
    "bindingdb": {
        "label": "BindingDB subset",
        "count": 2034,
        "compounds": [
            ["BDB-4201", 9.31, 9.02, "Reproduced"],
            ["BDB-1844", 9.05, 8.80, "Live Prediction"],
            ["BDB-7352", 8.84, 8.71, "Live Prediction"],
            ["BDB-2910", 8.58, 8.36, "Published"],
            ["BDB-6643", 8.37, 8.09, "Published"],
            ["BDB-5029", 8.21, 7.95, "Demo Data"],
            ["BDB-1186", 7.96, 7.82, "Demo Data"],
            ["BDB-3704", 7.79, 7.54, "Demo Data"],
            ["BDB-2268", 7.42, 7.11, "Demo Data"],
            ["BDB-9013", 7.14, 6.96, "Demo Data"],
        ],
    },
    "kiba": {
        "label": "KIBA reference subset",
        "count": 1284,
        "compounds": [
            ["KIBA-113", 9.22, 9.04, "Published"],
            ["KIBA-027", 8.93, 8.76, "Reproduced"],
            ["KIBA-086", 8.74, 8.39, "Live Prediction"],
            ["KIBA-015", 8.45, 8.20, "Live Prediction"],
            ["KIBA-101", 8.26, 8.03, "Demo Data"],
            ["KIBA-069", 8.02, 7.83, "Demo Data"],
            ["KIBA-044", 7.88, 7.59, "Demo Data"],
            ["KIBA-122", 7.62, 7.44, "Demo Data"],
            ["KIBA-058", 7.39, 7.08, "Demo Data"],
            ["KIBA-009", 7.11, 6.84, "Demo Data"],
        ],
    },
}


@dataclass
class ScreeningTask:
    task_id: str
    target_name: str
    mutation: str
    sequence_length: int
    library: str
    candidate_count: int
    model: str
    top_k: int
    status: str
    created_at: float
    finished_at: float | None
    run_mode: str = "Demo Data"
    unit: str = "pKd"


TASKS: dict[str, ScreeningTask] = {}
RESULTS: dict[str, list[dict[str, Any]]] = {}


def connect_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with connect_db() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS screening_tasks (
                task_id TEXT PRIMARY KEY,
                target_name TEXT NOT NULL,
                mutation TEXT NOT NULL,
                sequence_length INTEGER NOT NULL,
                library TEXT NOT NULL,
                candidate_count INTEGER NOT NULL,
                model TEXT NOT NULL,
                top_k INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                finished_at REAL,
                run_mode TEXT NOT NULL,
                unit TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS screening_results (
                task_id TEXT NOT NULL,
                rank INTEGER NOT NULL,
                drug TEXT NOT NULL,
                affinity REAL NOT NULL,
                tsedta REAL NOT NULL,
                mredta REAL NOT NULL,
                priority TEXT NOT NULL,
                evidence TEXT NOT NULL,
                smiles TEXT NOT NULL,
                agreement INTEGER NOT NULL,
                PRIMARY KEY (task_id, rank)
            )
            """
        )


def save_task(task: ScreeningTask, results: list[dict[str, Any]]) -> None:
    with connect_db() as connection:
        connection.execute(
            """
            INSERT OR REPLACE INTO screening_tasks VALUES (
                :task_id, :target_name, :mutation, :sequence_length, :library,
                :candidate_count, :model, :top_k, :status, :created_at,
                :finished_at, :run_mode, :unit
            )
            """,
            asdict(task),
        )
        connection.executemany(
            """
            INSERT OR REPLACE INTO screening_results VALUES (
                :task_id, :rank, :drug, :affinity, :tsedta, :mredta,
                :priority, :evidence, :smiles, :agreement
            )
            """,
            [{"task_id": task.task_id, **row} for row in results],
        )


def load_task(task_id: str) -> tuple[ScreeningTask, list[dict[str, Any]]] | None:
    with connect_db() as connection:
        task_row = connection.execute("SELECT * FROM screening_tasks WHERE task_id = ?", (task_id,)).fetchone()
        if task_row is None:
            return None
        result_rows = connection.execute(
            "SELECT rank, drug, affinity, tsedta, mredta, priority, evidence, smiles, agreement FROM screening_results WHERE task_id = ? ORDER BY rank",
            (task_id,),
        ).fetchall()
    task = ScreeningTask(**dict(task_row))
    return task, [dict(row) for row in result_rows]


def json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")


def parse_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or 0)
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def normalize_results(dataset_key: str, model: str, custom_drugs: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    if custom_drugs:
        compounds = []
        for index, drug in enumerate(custom_drugs, start=1):
            base = max(6.45, 9.55 - index * 0.17)
            tsedta = round(base, 2)
            mredta = round(base - 0.12 - (index % 3) * 0.05, 2)
            compounds.append([drug.get("drug_name") or drug.get("drug_id") or f"Uploaded-{index:03d}", tsedta, mredta, "Demo Data", drug.get("smiles") or ""])
    else:
        dataset = DATASETS.get(dataset_key, DATASETS["egfr"])
        compounds = dataset["compounds"]
    rows: list[dict[str, Any]] = []
    for index, compound in enumerate(compounds, start=1):
        drug, tsedta, mredta, evidence = compound[:4]
        smiles = compound[4] if len(compound) > 4 and compound[4] else "CCOc1ccc2nc(S(N)(=O)=O)sc2c1"
        score = mredta if model == "MREDTA" else tsedta
        rows.append(
            {
                "rank": index,
                "drug": drug,
                "tsedta": tsedta,
                "mredta": mredta,
                "affinity": score,
                "evidence": evidence,
                "priority": "High" if score >= 8.8 else "Medium" if score >= 8.0 else "Watch",
                "smiles": smiles,
                "agreement": round(max(0, 100 - abs(tsedta - mredta) * 24)),
            }
        )
    return rows


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "TargetNovaDemo/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed.path, parse_qs(parsed.query))
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/screenings":
            self.create_screening()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        if path == "/api/health":
            self.send_json({"ok": True, "service": "target-nova-demo-api"})
            return
        if path == "/api/tasks":
            self.send_json(self.list_tasks())
            return
        if path == "/api/datasets":
            self.send_json(
                [
                    {"key": key, "label": value["label"], "count": value["count"]}
                    for key, value in DATASETS.items()
                ]
            )
            return
        if path.startswith("/api/screenings/"):
            parts = path.strip("/").split("/")
            if len(parts) >= 3:
                self.get_screening(parts[2], parts[3] if len(parts) > 3 else "", query)
                return
        self.send_error(HTTPStatus.NOT_FOUND)

    def create_screening(self) -> None:
        try:
            payload = parse_json(self)
            library = payload.get("library") or "egfr"
            custom_drugs = payload.get("customDrugs") if isinstance(payload.get("customDrugs"), list) else []
            model = payload.get("model") or "TSEDTA"
            sequence = "".join(str(payload.get("proteinSequence") or "").split())
            top_k = int(payload.get("topK") or 20)
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "Invalid request body"}, HTTPStatus.BAD_REQUEST)
            return

        if library not in DATASETS and not custom_drugs:
            self.send_json({"error": "Unknown candidate library"}, HTTPStatus.BAD_REQUEST)
            return
        if model not in {"TSEDTA", "MREDTA", "Both"}:
            self.send_json({"error": "Unknown model"}, HTTPStatus.BAD_REQUEST)
            return
        if not sequence:
            self.send_json({"error": "Protein sequence is required"}, HTTPStatus.BAD_REQUEST)
            return

        task_id = uuid.uuid4().hex[:12]
        created_at = time.time()
        task = ScreeningTask(
            task_id=task_id,
            target_name=str(payload.get("targetName") or "EGFR"),
            mutation=str(payload.get("mutation") or "T790M"),
            sequence_length=len(sequence),
            library=library,
            candidate_count=len(custom_drugs) if custom_drugs else DATASETS[library]["count"],
            model=model,
            top_k=max(5, min(top_k, 50)),
            status="completed",
            created_at=created_at,
            finished_at=created_at + 0.8,
        )
        results = normalize_results(library, "TSEDTA" if model == "Both" else model, custom_drugs)
        TASKS[task_id] = task
        RESULTS[task_id] = results
        save_task(task, results)
        self.send_json({"task": asdict(task), "results": results[: task.top_k]}, HTTPStatus.CREATED)

    def get_screening(self, task_id: str, suffix: str, query: dict[str, list[str]]) -> None:
        cached = (TASKS.get(task_id), RESULTS.get(task_id))
        stored = None if cached[0] and cached[1] else load_task(task_id)
        if stored:
            task, results = stored
            TASKS[task_id] = task
            RESULTS[task_id] = results
        elif cached[0] and cached[1]:
            task, results = cached
        else:
            self.send_json({"error": "Task not found"}, HTTPStatus.NOT_FOUND)
            return
        if suffix == "results":
            limit = int(query.get("limit", [task.top_k])[0])
            self.send_json({"task": asdict(task), "results": results[:limit]})
            return
        if suffix == "report":
            self.send_report(task, results)
            return
        self.send_json({"task": asdict(task)})

    def list_tasks(self) -> list[dict[str, Any]]:
        with connect_db() as connection:
            rows = connection.execute(
                "SELECT task_id, target_name, mutation, candidate_count, model, status, created_at, run_mode FROM screening_tasks ORDER BY created_at DESC LIMIT 20"
            ).fetchall()
        return [dict(row) for row in rows]

    def serve_static(self, path: str) -> None:
        target = ROOT / "index.html" if path in {"", "/"} else ROOT / path.lstrip("/")
        try:
            target = target.resolve()
            if not target.is_file() or ROOT not in target.parents and target != ROOT:
                raise FileNotFoundError
            content = target.read_bytes()
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def send_report(self, task: ScreeningTask, results: list[dict[str, Any]]) -> None:
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["rank", "drug", "affinity", "tsedta", "mredta", "priority", "evidence"])
        for row in results:
            writer.writerow(
                [row["rank"], row["drug"], row["affinity"], row["tsedta"], row["mredta"], row["priority"], row["evidence"]]
            )
        content = buffer.getvalue().encode("utf-8-sig")
        filename = f"target-nova-{task.task_id}-screening.csv"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    init_db()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer((host, port), ApiHandler)
    print(f"Target·NOVA is running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()