import React, { useState, useEffect, useRef } from 'react';
// The Neo4j JS driver
import neo4j from 'neo4j-driver';

// The NVL React component + types
import { InteractiveNvlWrapper } from '@neo4j-nvl/react';
import type { Node as NVLNode, Relationship as NVLRelationship } from '@neo4j-nvl/base';

// These callbacks help us capture hovers, clicks, etc.
import type { HitTargets, Node, Relationship } from '@neo4j-nvl/base';
import type { MouseEventCallbacks } from '@neo4j-nvl/react';

import './App.css';

// Neo4j connection details from environment variables
const NEO4J_URI = import.meta.env.VITE_NEO4J_URI || 'neo4j://localhost:7687';
const NEO4J_USER = import.meta.env.VITE_NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = import.meta.env.VITE_NEO4J_PASSWORD;

if (!NEO4J_PASSWORD) {
  throw new Error('Neo4j password not set in environment variables');
}

interface UserNode extends NVLNode {
  data: {
    username: string;
    displayName: string;
    bio: string;
    location: string;
    avatar: string;
    fallbackIcon?: string; // Add fallback icon
  };
}

function createAvatarHtml(url: string): HTMLElement {
  const container = document.createElement('div');
  
  // Make the container fill the entire node diameter
  container.style.width = '100%';
  container.style.height = '100%';

  // Make it a circle
  container.style.borderRadius = '50%';
  container.style.overflow = 'hidden';

  // Use background-image to fill the container
  container.style.background = `url('${url}') center/cover no-repeat`;

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

const App = () => {
  // Store the graph data for NVL
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [rels, setRels] = useState<NVLRelationship[]>([]);

  // Store info for a custom tooltip when hovering
  const [hoveredNode, setHoveredNode] = useState<UserNode | null>(null);
  const [hoverCoords, setHoverCoords] = useState({ x: 0, y: 0 });

  // This ref gives us access to the NVL instance if we want to call methods on it
  const nvlRef = useRef<any>(null);

  // On mount, fetch from Neo4j
  useEffect(() => {
    const fetchData = async () => {
      const driver = neo4j.driver(
        NEO4J_URI,
        neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
      );
      const session = driver.session();

      try {
        // 1) Fetch user nodes
        const nodeQuery = `
          MATCH (u:User)
          RETURN u.id AS id,
                 u.username AS username,
                 u.account_display_name AS displayName,
                 u.avatar_media_url AS avatar,
                 u.bio AS bio,
                 u.location AS location
        `;
        const nodeResult = await session.run(nodeQuery);
        const nvlNodes: UserNode[] = nodeResult.records.map((rec) => {
          const id = rec.get('id');
          const username = rec.get('username') || '';
          const displayName = rec.get('displayName') || '';
          const avatar = rec.get('avatar') || '';
          const bio = rec.get('bio') || '';
          const location = rec.get('location') || '';

          // Generate fallback icon data
          const initials = getInitials(displayName, username);
          const backgroundColor = getColorFromString(username);
          const fallbackIcon = createTextAvatar(initials, backgroundColor);

          // Return NVL-friendly node
          return {
            id,
            data: { 
              username, 
              displayName, 
              bio, 
              location, 
              avatar,
              fallbackIcon 
            },
            // Use the fallback icon as a backup
            icon: avatar || fallbackIcon,
            // Increase node size and adjust styling for better image display
            size: 40,
            html: createAvatarHtml(avatar)
          };
        });

        // 2) Fetch relationships
        const relQuery = `
          MATCH (a:User)-[rel:FOLLOWED_BY]->(b:User)
          RETURN rel, a.id AS fromId, b.id AS toId
        `;
        const relResult = await session.run(relQuery);
        const nvlRels: NVLRelationship[] = relResult.records.map((rec, idx) => {
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
      } catch (err) {
        console.error('Neo4j query error', err);
      } finally {
        await session.close();
        await driver.close();
      }
    };

    fetchData();
  }, []);

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
    <div style={{
      position: 'relative',
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      background: '#f5f5f5'
    }}>
      {/* The NVL React wrapper */}
      <InteractiveNvlWrapper
        ref={nvlRef}
        nodes={nodes}
        rels={rels}
        mouseEventCallbacks={mouseEventCallbacks}
        // Example NVL options: initial zoom, forced-directed layout, etc.
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
          }}
        >
          <div style={{ fontWeight: 'bold' }}>{hoveredNode.data.displayName || hoveredNode.data.username}</div>
          <div>@{hoveredNode.data.username}</div>
          {hoveredNode.data.bio && <div>{hoveredNode.data.bio}</div>}
          {hoveredNode.data.location && <div>{hoveredNode.data.location}</div>}
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
    </div>
  );
};

export default App;
