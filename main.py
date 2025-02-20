#!/usr/bin/env python3

import psycopg2
import os
from neo4j import GraphDatabase

###############################################################################
# 1. CONFIGURATION
###############################################################################

POSTGRES_CONFIG = {
    "host": "localhost",
    "port": 54322,  # Supabase local development DB port
    "dbname": "postgres",  # Default Supabase database name
    "user": "postgres",  # Default Supabase user
    "password": "postgres",  # Default local Supabase password
    # Add SSL mode for local development
    "sslmode": "disable"
}

NEO4J_URI = "neo4j://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "your_password"

# Where we store the CSV exports before loading into Neo4j.
CSV_EXPORT_DIR = os.path.expanduser("~/neo4j/csv_exports")

# The tables you want to export. Each entry is (table_name, output_csv_name).
# Adjust as you see fit!
TABLES_TO_EXPORT = [
    ("account",         "account.csv"),
    ("enriched_tweets", "enriched_tweets.csv"),
    ("followers",       "followers.csv"),
    ("following",       "following.csv"),
    ("likes",           "likes.csv"),
    ("tweet_media",     "tweet_media.csv"),
]

###############################################################################
# 2. HELPER: EXPORTING TABLES TO CSV
###############################################################################

def export_table_to_csv(cursor, table_name, csv_file_path):
    """
    Uses PostgreSQL's COPY command to export an entire table to a CSV file.
    """
    query = f"COPY (SELECT * FROM {table_name}) TO STDOUT WITH CSV HEADER"
    with open(csv_file_path, "w", encoding="utf-8") as f:
        cursor.copy_expert(query, f)

###############################################################################
# 3. LOADING CSV FILES INTO NEO4J
###############################################################################

def load_data_into_neo4j(driver):
    """
    Uses Cypher LOAD CSV to ingest nodes and relationships.
    Because the user's schema does not include explicit foreign keys,
    we've guessed or inferred relationships. Customize as needed.
    """
    with driver.session() as session:
        
        #----------------------------------------------------------------------
        # (A) Create constraints / indexes on :Account(account_id), :Tweet(tweet_id), etc.
        #----------------------------------------------------------------------

        # For uniqueness on accounts
        session.run("""
        CREATE CONSTRAINT IF NOT EXISTS
        FOR (a:Account) REQUIRE a.account_id IS UNIQUE
        """)

        # For uniqueness on tweets
        session.run("""
        CREATE CONSTRAINT IF NOT EXISTS
        FOR (t:Tweet) REQUIRE t.tweet_id IS UNIQUE
        """)

        # For uniqueness on media
        session.run("""
        CREATE CONSTRAINT IF NOT EXISTS
        FOR (m:Media) REQUIRE m.media_id IS UNIQUE
        """)

        # Wait for indexes to be online
        session.run("CALL db.awaitIndexes()")
        
        #----------------------------------------------------------------------
        # (B) Load :Account nodes from account.csv
        #----------------------------------------------------------------------
        
        session.run(f"""
        USING PERIODIC COMMIT 1000
        LOAD CSV WITH HEADERS FROM 'file:///{TABLES_TO_EXPORT[0][1]}' AS row
        MERGE (a:Account {{account_id: row.account_id}})
          ON CREATE SET a.username = row.username,
                        a.created_at = row.created_at,
                        a.created_via = row.created_via,
                        a.account_display_name = row.account_display_name,
                        a.num_tweets = toInteger(row.num_tweets),
                        a.num_following = toInteger(row.num_following),
                        a.num_followers = toInteger(row.num_followers),
                        a.num_likes = toInteger(row.num_likes)
        """)
        
        #----------------------------------------------------------------------
        # (C) Load :Tweet nodes from enriched_tweets.csv
        #----------------------------------------------------------------------
        
        session.run(f"""
        USING PERIODIC COMMIT 1000
        LOAD CSV WITH HEADERS FROM 'file:///{TABLES_TO_EXPORT[1][1]}' AS row
        // Create a tweet node
        MERGE (tw:Tweet {{tweet_id: row.tweet_id}})
          ON CREATE SET tw.full_text       = row.full_text,
                        tw.created_at      = row.created_at,
                        tw.retweet_count   = toInteger(row.retweet_count),
                        tw.favorite_count  = toInteger(row.favorite_count)
        
        // Also create a relationship from the tweeting account -> the tweet
        // "account_id" is presumably the user who posted it.
        WITH tw, row
        MATCH (a:Account {{account_id: row.account_id}})
        MERGE (a)-[:TWEETED]->(tw)
        """)
        
        #----------------------------------------------------------------------
        # (D) Followers -> create relationship: :Account -[:FOLLOWS]-> :Account
        #----------------------------------------------------------------------
        # The "followers" table often has (account_id, follower_account_id).
        # We interpret that as "follower_account_id" FOLLOWS "account_id".

        session.run(f"""
        USING PERIODIC COMMIT 1000
        LOAD CSV WITH HEADERS FROM 'file:///{TABLES_TO_EXPORT[2][1]}' AS row
        MATCH (acc:Account {{account_id: row.account_id}})
        MATCH (follower:Account {{account_id: row.follower_account_id}})
        MERGE (follower)-[:FOLLOWS]->(acc)
        """)

        #----------------------------------------------------------------------
        # (E) Following -> create relationship: :Account -[:FOLLOWS]-> :Account
        #----------------------------------------------------------------------
        # Some data models store "following" as (account_id, following_account_id).
        # We interpret that as "account_id" FOLLOWS "following_account_id".

        session.run(f"""
        USING PERIODIC COMMIT 1000
        LOAD CSV WITH HEADERS FROM 'file:///{TABLES_TO_EXPORT[3][1]}' AS row
        MATCH (acc:Account {{account_id: row.account_id}})
        MATCH (followee:Account {{account_id: row.following_account_id}})
        MERGE (acc)-[:FOLLOWS]->(followee)
        """)
        
        #----------------------------------------------------------------------
        # (F) Likes -> create relationship: :Account -[:LIKES]-> :Tweet
        #----------------------------------------------------------------------
        # The "likes" table typically has (account_id, liked_tweet_id).

        session.run(f"""
        USING PERIODIC COMMIT 1000
        LOAD CSV WITH HEADERS FROM 'file:///{TABLES_TO_EXPORT[4][1]}' AS row
        MATCH (a:Account {{account_id: row.account_id}})
        MATCH (t:Tweet   {{tweet_id: row.liked_tweet_id}})
        MERGE (a)-[:LIKES]->(t)
        """)
        
        #----------------------------------------------------------------------
        # (G) Tweet media -> create relationship: :Tweet -[:HAS_MEDIA]-> :Media
        #----------------------------------------------------------------------
        # The "tweet_media" table has (media_id, tweet_id, media_url, media_type, ...).
        
        session.run(f"""
        USING PERIODIC COMMIT 1000
        LOAD CSV WITH HEADERS FROM 'file:///{TABLES_TO_EXPORT[5][1]}' AS row
        MERGE (m:Media {{media_id: toInteger(row.media_id)}})
          ON CREATE SET m.media_url  = row.media_url,
                        m.media_type = row.media_type,
                        m.width      = toInteger(row.width),
                        m.height     = toInteger(row.height)
        WITH m, row
        MATCH (t:Tweet {{tweet_id: row.tweet_id}})
        MERGE (t)-[:HAS_MEDIA]->(m)
        """)
        
        print("Data load into Neo4j completed successfully!")


###############################################################################
# 4. MAIN SCRIPT
###############################################################################

def main():
    # Ensure CSV export directory exists
    os.makedirs(CSV_EXPORT_DIR, exist_ok=True)
    
    #------------------------------------------------------------------------
    # A. CONNECT TO SUPABASE (POSTGRES) AND EXPORT TABLES
    #------------------------------------------------------------------------
    print("Connecting to Postgres (Supabase)...")
    try:
        conn = psycopg2.connect(**POSTGRES_CONFIG)
        conn.autocommit = True
        cursor = conn.cursor()
        print("Successfully connected to Supabase PostgreSQL!")
    except Exception as e:
        print(f"Error connecting to Supabase PostgreSQL: {e}")
        return
    
    print("Exporting tables to CSV...")
    for table_name, csv_filename in TABLES_TO_EXPORT:
        csv_path = os.path.join(CSV_EXPORT_DIR, csv_filename)
        print(f"  -> Exporting {table_name} to {csv_path}")
        export_table_to_csv(cursor, table_name, csv_path)
    
    cursor.close()
    conn.close()
    print("Postgres export complete.\n")
    
    #------------------------------------------------------------------------
    # B. CONNECT TO NEO4J AND LOAD CSV
    #------------------------------------------------------------------------
    print("Connecting to Neo4j...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    print("Loading CSV data into Neo4j...")
    load_data_into_neo4j(driver)

    driver.close()
    print("Done.")

if __name__ == "__main__":
    main()

