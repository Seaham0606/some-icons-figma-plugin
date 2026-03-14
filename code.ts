// code.ts
figma.showUI(__html__, { width: 360, height: 520 });

type InsertMessage = {
  type: "INSERT_ICON";
  payload: {
    name: string;
    svg: string;
    size: number; // px
  };
};

type ReplaceMessage = {
  type: "REPLACE_ICON";
  payload: {
    name: string;
    svg: string;
    size: number; // px
    nodeId: string;
  };
};

type OpenExternalMessage = {
  type: "OPEN_EXTERNAL";
  payload: {
    url: string;
  };
};

type CheckSelectionMessage = {
  type: "CHECK_SELECTION";
};

type UIMessage = InsertMessage | ReplaceMessage | OpenExternalMessage | CheckSelectionMessage;

function traverse(node: SceneNode, fn: (n: SceneNode) => void) {
  fn(node);
  if ("children" in node) {
    for (const c of node.children) traverse(c as SceneNode, fn);
  }
}

function canResize(
  node: SceneNode
): node is SceneNode & { resize: (w: number, h: number) => void } {
  return typeof (node as any).resize === "function";
}

function scaleToSize(node: SceneNode, target: number) {
  const w = node.width;
  const h = node.height;
  if (w === 0 || h === 0) return;

  const scale = target / Math.max(w, h);

  if (canResize(node)) {
    node.resize(w * scale, h * scale);
    return;
  }

  // Fallback (rare): resize first resizable child
  if ("children" in node) {
    for (const child of node.children as SceneNode[]) {
      if (canResize(child)) {
        child.resize(child.width * scale, child.height * scale);
        break;
      }
    }
  }
}

function placeNearViewportCenter(node: SceneNode) {
  const vp = figma.viewport.center;
  node.x = vp.x - node.width / 2;
  node.y = vp.y - node.height / 2;
}

// Check if a node is likely an icon instance created by this plugin
// Icons created from SVG are typically Frames with Vector children
function isIconInstance(node: SceneNode): boolean {
  // Check if it's a Frame or Group (typical structure from createNodeFromSvg)
  if (node.type !== "FRAME" && node.type !== "GROUP") {
    console.log("Node is not FRAME or GROUP, type:", node.type);
    return false;
  }

  // Check if it has vector children (SVG paths)
  // This is the key indicator of an SVG-based icon
  if ("children" in node && node.children.length > 0) {
    const hasVectorChildren = node.children.some(
      (child) => child.type === "VECTOR" || child.type === "BOOLEAN_OPERATION"
    );
    if (!hasVectorChildren) {
      console.log("Node has no vector children");
      return false;
    }
  } else {
    // No children means it's not an icon
    console.log("Node has no children");
    return false;
  }

  // Node name should not be empty (icons are named with their icon ID)
  const name = node.name.trim();
  if (name.length === 0) {
    console.log("Node name is empty");
    return false;
  }

  console.log("Node passed icon instance check:", name);
  return true;
}

// Get the icon name from a node (assuming it's stored in the node name)
function getIconNameFromNode(node: SceneNode): string | null {
  if (!isIconInstance(node)) {
    return null;
  }
  return node.name.trim() || null;
}

// Check current selection and notify UI
function checkSelectionAndNotify() {
  try {
    const selection = figma.currentPage.selection;
    console.log("Checking selection, count:", selection.length);
    
    if (selection.length === 1) {
      const selectedNode = selection[0];
      console.log("Selected node type:", selectedNode.type, "name:", selectedNode.name);
      
      const iconName = getIconNameFromNode(selectedNode);
      console.log("Detected icon name:", iconName);
      
      if (iconName) {
        // Send icon name to UI so it can scroll to it
        console.log("Sending ICON_SELECTED message with icon:", iconName);
        figma.ui.postMessage({
          type: "ICON_SELECTED",
          payload: {
            iconName: iconName,
            nodeId: selectedNode.id,
          },
        });
        return;
      }
    }
    
    // No valid icon selected
    console.log("No valid icon selected, sending null");
    figma.ui.postMessage({
      type: "ICON_SELECTED",
      payload: {
        iconName: null,
        nodeId: null,
      },
    });
  } catch (e) {
    console.error("Error in checkSelectionAndNotify:", e);
    // Still send a message to clear selection
    figma.ui.postMessage({
      type: "ICON_SELECTED",
      payload: {
        iconName: null,
        nodeId: null,
      },
    });
  }
}

figma.ui.onmessage = async (msg: UIMessage) => {
  // Debug: log received messages (remove in production if needed)
  console.log("Plugin received message:", msg.type);
  
  if (msg.type === "INSERT_ICON") {
    const { name, svg, size } = msg.payload;

    try {
      const created = figma.createNodeFromSvg(svg);
      created.name = name;

      // Normalize size (based on max(w, h))
      scaleToSize(created, size);

      // Ensure it is on the page
      if (!created.parent) {
        figma.currentPage.appendChild(created);
      }

      // Place and select
      placeNearViewportCenter(created);
      figma.currentPage.selection = [created];
      figma.viewport.scrollAndZoomIntoView([created]);
    } catch (e) {
      // UI feedback removed per request; see console if needed.
      console.error(e);
    }
  } else if (msg.type === "REPLACE_ICON") {
    const { name, svg, size, nodeId } = msg.payload;

    // Use async function since we need getNodeByIdAsync for dynamic-page access
    (async () => {
      try {
        console.log("REPLACE_ICON received:", { name, nodeId, size });
        
        // Find the node to replace - must use async version for dynamic-page
        const nodeToReplace = await figma.getNodeByIdAsync(nodeId);
        console.log("Node found:", nodeToReplace ? nodeToReplace.type : "null");
        
        // Check if it's a SceneNode and is an icon instance
        if (!nodeToReplace || nodeToReplace.type === "DOCUMENT" || nodeToReplace.type === "PAGE") {
          console.log("Node not found or invalid type, falling back to insert");
          // Fallback to insert if node not found or invalid type
          const created = figma.createNodeFromSvg(svg);
          created.name = name;
          scaleToSize(created, size);
          if (!created.parent) {
            figma.currentPage.appendChild(created);
          }
          placeNearViewportCenter(created);
          figma.currentPage.selection = [created];
          figma.viewport.scrollAndZoomIntoView([created]);
          return;
        }
        
        const sceneNode = nodeToReplace as SceneNode;
        
        if (!isIconInstance(sceneNode)) {
          console.log("Node is not an icon instance, falling back to insert");
          // Fallback to insert if not an icon instance
          const created = figma.createNodeFromSvg(svg);
          created.name = name;
          scaleToSize(created, size);
          if (!created.parent) {
            figma.currentPage.appendChild(created);
          }
          placeNearViewportCenter(created);
          figma.currentPage.selection = [created];
          figma.viewport.scrollAndZoomIntoView([created]);
          return;
        }

        console.log("Replacing icon at position:", sceneNode.x, sceneNode.y);

        // Get position and parent before replacing
        const parent = sceneNode.parent;
        const x = sceneNode.x;
        const y = sceneNode.y;
        const width = sceneNode.width;
        const height = sceneNode.height;

        // Create new icon
        const created = figma.createNodeFromSvg(svg);
        created.name = name;
        scaleToSize(created, size);

        // Place at same position
        created.x = x;
        created.y = y;

        // Insert into same parent (before removing old node to maintain order)
        if (parent && "children" in parent) {
          // Find the index of the old node
          const index = parent.children.indexOf(sceneNode);
          console.log("Old node index in parent:", index);
          if (index >= 0) {
            // Insert at the same position
            parent.insertChild(index, created);
          } else {
            // Fallback: append if index not found
            parent.appendChild(created);
          }
        } else {
          // Fallback: append to page if no parent
          figma.currentPage.appendChild(created);
        }

        // Remove old node
        sceneNode.remove();
        console.log("Icon replaced successfully, new node ID:", created.id);

        // Select new node (but don't change viewport - keep user's current view)
        figma.currentPage.selection = [created];
        // Don't scroll viewport - keep it where the user has it
        // figma.viewport.scrollAndZoomIntoView([created]);
        
        // Notify UI that replacement is complete (so it can update selection tracking)
        checkSelectionAndNotify();
      } catch (e) {
        console.error("Error replacing icon:", e);
      }
    })();
  } else if (msg.type === "CHECK_SELECTION") {
    checkSelectionAndNotify();
  } else if (msg.type === "OPEN_EXTERNAL") {
    const { url } = msg.payload;
    figma.openExternal(url);
  }
};

// Listen for selection changes
figma.on("selectionchange", () => {
  checkSelectionAndNotify();
});

// Wait for UI to be ready before checking selection
// The UI will request it when ready via CHECK_SELECTION message
