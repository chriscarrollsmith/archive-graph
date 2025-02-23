# Python import script

This script imports data from a PostgreSQL database into a Neo4j graph database.

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

## Import Data

```bash
uv run python scripts/import.py
```

# Vite React Graph Viewer

## Pre-requisites

- [Node.js](https://nodejs.org/en/download/)

## Install dependencies

```bash
npm install
```

## Run the app

```bash
npm start
```

## View the Graph

Navigate to `http://localhost:7474/browser/` and login with your credentials ("neo4j" and "your-password" if you ran the Docker command above verbatim). Then click the "User" node to view the graph.

