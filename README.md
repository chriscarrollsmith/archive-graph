## Pre-requisites

- uv
- python
- [Docker](https://www.docker.com/)

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install python
uv python install
```

## Environment

```bash
cp .env.example .env
```

## Neo4j Installation

```bash
docker run -d --name neo4j -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/your-password -v neo4j-data:/data neo4j:latest
```

## Repo Installation

```bash
git clone https://github.com/chriscarrollsmith/archive-graph.git
cd archive-graph

# Install dependencies
uv sync
```

## Usage

```bash
uv run python import.py
```
