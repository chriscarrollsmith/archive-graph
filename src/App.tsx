import React, { useState, useEffect, useRef, Component } from 'react';
// The Neo4j JS driver
import neo4j from 'neo4j-driver';
import type { Driver, Session, Record } from 'neo4j-driver';

// The NVL React component + types
import { InteractiveNvlWrapper } from '@neo4j-nvl/react';
import type { Node as NVLNode, Relationship as NVLRelationship } from '@neo4j-nvl/base';

// These callbacks help us capture hovers, clicks, etc.
import type { HitTargets, Node, Relationship } from '@neo4j-nvl/base';
import type { MouseEventCallbacks } from '@neo4j-nvl/react';

import './App.css';

// Neo4j connection details from environment variables
const NEO4J_URI = import.meta.env.VITE_NEO4J_URI;
const NEO4J_USER = import.meta.env.VITE_NEO4J_USER;
const NEO4J_PASSWORD = import.meta.env.VITE_NEO4J_PASSWORD;

// No longer strictly necessary, but good for clarity:
if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
  throw new Error('Neo4j connection details not set in environment variables');
}

interface UserNode extends NVLNode {
  data: {
    username: string;
    displayName: string;
    bio: string;
    location: string;
    avatar: string;
    fallbackIcon?: string; // Add fallback icon
    inDegree: number;
    outDegree: number;
    pageRank: number;
    betweenness: number;
  };
}

function createAvatarHtml(url: string, fallbackIcon: string): HTMLElement {
  const container = document.createElement('div');
  
  // Make the container fill the entire node diameter
  container.style.width = '100%';
  container.style.height = '100%';

  // Make it a circle
  container.style.borderRadius = '50%';
  container.style.overflow = 'hidden';

  // Create an image element to pre-load and check for errors
  const img = new Image();
  img.src = url;

  img.onload = () => {
    // If the image loads successfully, use it as the background
    container.style.background = `url('${url}') center/cover no-repeat`;
  }

  img.onerror = () => {
    // If there's an error loading the image, use the fallback icon
    container.style.background = `url('${fallbackIcon}') center/cover no-repeat`;
  }

  return container;
}

// Function to generate initials from display name or username
const getInitials = (displayName: string, username: string): string => {
  if (displayName) {
    const names = displayName.split(' ');
    if (names.length >= 2) {
      return `${names[0][0]}${names[1][0]}`.toUpperCase();
    }
    return displayName[0].toUpperCase();
  }
  return username[0].toUpperCase();
};

// Function to generate a color based on username
const getColorFromString = (str: string): string => {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
    '#D4A5A5', '#9B59B6', '#3498DB', '#1ABC9C', '#F1C40F'
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

// Function to create a data URL for a text-based avatar
const createTextAvatar = (initials: string, backgroundColor: string): string => {
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Draw background
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw text
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 40px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, canvas.width / 2, canvas.height / 2);

  return canvas.toDataURL('image/png');
};

// Error boundary to catch rendering errors
class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('Visualization error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20 }}>
          <h2>Something went wrong with the visualization.</h2>
          <button onClick={() => window.location.reload()}>Reload Page</button>
        </div>
      );
    }

    return this.props.children;
  }
}

const App = () => {
  // Store the graph data for NVL
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [rels, setRels] = useState<NVLRelationship[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  // Store info for a custom tooltip when hovering
  const [hoveredNode, setHoveredNode] = useState<UserNode | null>(null);
  const [hoverCoords, setHoverCoords] = useState({ x: 0, y: 0 });

  // This ref gives us access to the NVL instance if we want to call methods on it
  const nvlRef = useRef<any>(null);

  // Add loading state
  const [isLoading, setIsLoading] = useState(true);

  // On mount, fetch from Neo4j
  useEffect(() => {
    let driver: Driver | null = null;

    const fetchData = async () => {
      if (isInitialized) {
        return;
      }

      setIsLoading(true);
      try {
        driver = neo4j.driver(
          NEO4J_URI,
          neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
        );

        // Fetch nodes with metrics in a single transaction
        const nodeSession = driver.session();
        try {
          const nodeResult = await nodeSession.executeWrite(async tx => {
            // First drop any existing projection
            await tx.run(`
              CALL gds.graph.drop('user-network', false)
              YIELD graphName
            `);

            // Create the projection
            const projResult = await tx.run(`
              CALL gds.graph.project('user-network',
                'User',
                {
                  FOLLOWED_BY: {
                    orientation: 'UNDIRECTED'
                  }
                }
              )
              YIELD graphName, nodeCount, relationshipCount
            `);

            const projectedNodeCount = projResult.records[0].get('nodeCount').toNumber();
            console.log(`Graph projection created with ${projectedNodeCount} nodes`);

            if (projectedNodeCount === 0) {
              throw new Error('Graph projection created but contains no nodes');
            }

            // Run all metrics in a single query
            const result = await tx.run(`
              MATCH (u:User)
              WITH u
              
              // Calculate degree centrality
              CALL {
                WITH u
                RETURN 
                  COUNT { (u)<-[:FOLLOWED_BY]-() } as inDegree,
                  COUNT { (u)-[:FOLLOWED_BY]->() } as outDegree
              }

              // Calculate PageRank
              CALL {
                WITH u
                CALL gds.pageRank.stream('user-network')
                YIELD nodeId as prNodeId, score as pageRank
                WHERE id(u) = prNodeId
                RETURN pageRank
              }

              // Calculate betweenness centrality
              CALL {
                WITH u
                CALL gds.betweenness.stream('user-network')
                YIELD nodeId as btNodeId, score as betweenness
                WHERE id(u) = btNodeId
                RETURN betweenness
              }

              // Return all node data
              RETURN 
                u.id AS id,
                u.username AS username,
                u.account_display_name AS displayName,
                u.avatar_media_url AS avatar,
                u.bio AS bio,
                u.location AS location,
                inDegree,
                outDegree,
                pageRank,
                betweenness
            `);

            // Drop the projection immediately after use
            await tx.run(`
              CALL gds.graph.drop('user-network')
              YIELD graphName
            `);

            return result;
          });

          const nvlNodes: UserNode[] = nodeResult.records.map((rec: Record) => {
            const id = rec.get('id');
            const username = rec.get('username') || '';
            const displayName = rec.get('displayName') || '';
            const avatar = rec.get('avatar') || '';
            const bio = rec.get('bio') || '';
            const location = rec.get('location') || '';

            // Safely convert numeric values with fallbacks
            const safeNumber = (value: any, defaultValue: number = 0): number => {
              if (value && typeof value.toNumber === 'function') {
                return value.toNumber();
              }
              if (typeof value === 'number') {
                return value;
              }
              return defaultValue;
            };

            const inDegree = safeNumber(rec.get('inDegree'));
            const outDegree = safeNumber(rec.get('outDegree'));
            const pageRank = safeNumber(rec.get('pageRank'));
            const betweenness = safeNumber(rec.get('betweenness'));

            // Generate fallback icon data
            const initials = getInitials(displayName, username);
            const backgroundColor = getColorFromString(username);
            const fallbackIcon = createTextAvatar(initials, backgroundColor);

            // Return NVL-friendly node with centrality metrics
            return {
              id,
              data: { 
                username, 
                displayName, 
                bio, 
                location, 
                avatar,
                fallbackIcon,
                inDegree,
                outDegree,
                pageRank,
                betweenness
              },
              // Use the fallback icon as a backup
              icon: avatar || fallbackIcon,
              // Increase node size based on PageRank (normalized)
              size: 40 * (1 + pageRank),
              html: createAvatarHtml(avatar, fallbackIcon)
            };
          });

          // Fetch relationships
          const relResult = await nodeSession.executeRead(async tx => {
            const result = await tx.run(`
              MATCH (a:User)-[rel:FOLLOWED_BY]->(b:User)
              RETURN rel, a.id AS fromId, b.id AS toId
            `);
            return result;
          });

          const nvlRels: NVLRelationship[] = relResult.records.map((rec: Record, idx: number) => {
            const fromId = rec.get('fromId');
            const toId = rec.get('toId');
            // Must have unique ID for the relationship
            return {
              id: `rel-${idx}`,
              from: fromId,
              to: toId,
              color: '#666',
              width: 2,
              // optional label
              captions: [{ value: 'FOLLOWED_BY' }]
            };
          });

          setNodes(nvlNodes);
          setRels(nvlRels);
          setIsInitialized(true);

          // --- New code to log top users ---
          const topUsers = (metric: keyof UserNode['data']) => {
            const sorted = [...nvlNodes].sort((a, b) => (b.data[metric] as number) - (a.data[metric] as number));
            return sorted.slice(0, 3).map(node => ({
              username: node.data.username,
              value: node.data[metric]
            }));
          };

          console.log('Top 3 users by inDegree:', topUsers('inDegree'));
          console.log('Top 3 users by outDegree:', topUsers('outDegree'));
          console.log('Top 3 users by pageRank:', topUsers('pageRank'));
          console.log('Top 3 users by betweenness:', topUsers('betweenness'));
          // --- End of new code ---

        } finally {
          await nodeSession.close();
        }
      } catch (err) {
        console.error('Neo4j query error', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();

    // Return cleanup function
    return () => {
      const cleanup = async () => {
        if (driver) {
          await driver.close();
        }
      };
      cleanup();
    };
  }, [isInitialized]); // Only re-run if isInitialized changes

  // Set up the interaction callbacks
  const mouseEventCallbacks: MouseEventCallbacks = {
    onHover: (element: Node | Relationship, hitTargets: HitTargets, evt: MouseEvent) => {
      // Only show tooltips if we are hovering a node and it has the expected shape
      if (element && 'data' in element && isUserNode(element)) {
        setHoveredNode(element);
        setHoverCoords({ x: evt.clientX, y: evt.clientY });
      } else {
        // If we hover empty space or a relationship, clear the node tooltip
        setHoveredNode(null);
      }
    },
    onZoom: true,
    onPan: true,
    onDrag: true,
  };

  // Type guard to check if a node is a UserNode
  const isUserNode = (node: Node | Relationship): node is UserNode => {
    return 'data' in node && 
           typeof (node as any).data?.username === 'string' &&
           typeof (node as any).data?.displayName === 'string';
  };

  return (
    <ErrorBoundary>
      <div style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        background: '#f5f5f5'
      }}>
        {isLoading ? (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center'
          }}>
            <h2>Loading graph data...</h2>
          </div>
        ) : (
          <>
            <InteractiveNvlWrapper
              ref={nvlRef}
              nodes={nodes}
              rels={rels}
              mouseEventCallbacks={mouseEventCallbacks}
              nvlOptions={{
                layout: 'forceDirected',
                initialZoom: 0.75
              }}
            />

            {/* Simple absolute-positioned tooltip */}
            {hoveredNode && hoveredNode.data && (
              <div
                style={{
                  position: 'absolute',
                  backgroundColor: 'white',
                  border: '1px solid #ccc',
                  padding: '8px',
                  top: hoverCoords.y + 10,
                  left: hoverCoords.x + 10,
                  zIndex: 999,
                  pointerEvents: 'none', // So we don't block the mouse
                  borderRadius: '4px',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
              >
                <div style={{ fontWeight: 'bold' }}>{hoveredNode.data.displayName || hoveredNode.data.username}</div>
                <div>@{hoveredNode.data.username}</div>
                {hoveredNode.data.bio && <div style={{ marginTop: 4 }}>{hoveredNode.data.bio}</div>}
                {hoveredNode.data.location && <div style={{ marginTop: 4 }}>{hoveredNode.data.location}</div>}
                <div style={{ marginTop: 8, fontSize: '0.9em', color: '#666' }}>
                  <div>Followers: {hoveredNode.data.inDegree}</div>
                  <div>Following: {hoveredNode.data.outDegree}</div>
                  <div>PageRank: {hoveredNode.data.pageRank.toFixed(4)}</div>
                  <div>Betweenness: {hoveredNode.data.betweenness.toFixed(4)}</div>
                </div>
                {hoveredNode.data.avatar && (
                  <img
                    src={hoveredNode.data.avatar}
                    alt={hoveredNode.data.username}
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      if (hoveredNode.data.fallbackIcon) {
                        target.src = hoveredNode.data.fallbackIcon;
                      } else {
                        target.style.display = 'none';
                      }
                    }}
                    style={{ width: 80, height: 80, marginTop: 6, borderRadius: 6 }}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </ErrorBoundary>
  );
};

export default App;
