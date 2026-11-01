// NavMovements: subclass of mineflayer-pathfinder Movements with map-aware fixes for
// command-block RPG maps (盘灵古域).
// Root cause of wandering off cliffs / swimming into void:
//   the stock getBlock() returns { physical:false, safe:false, liquid:false } for a NULL
//   block (void / unloaded chunk). getMoveForward sees blockD.physical=false and
//   blockC.liquid=false and treats void as WALKABLE -> routes you off the map edge.
// Fix: override getBlock so a null block is marked physical:true (impassable wall),
//   so A* won't route through void.
// Also: water is walkable in stock code (liquidCost=1) — keep it costly but allow it
//   only as a last resort by bumping liquidCost high so dry paths win when they exist.
const Movements = require('mineflayer-pathfinder/lib/movements');
const Vec3 = require('vec3');

class NavMovements extends Movements {
  constructor(bot) {
    super(bot);
    this.canDig = false;           // adventure map: never break blocks
    this.allow1by1towers = false;  // no pillar-cheating
    this.allowParkour = false;     // no risky jumps into void
    this.liquidCost = 4;           // water is traversable but expensive -> dry route preferred
    // treat water/lava as passable but very costly so pathfinder only crosses when forced
    this.blockVoid = true;
    this.maxDropDown = 3;          // 沙漠坑：别一次跳下太深
    // 别踩已知传送板（踩上会被传到别处，如中转站的蜀山/崑崙板）。主动用传送时 travel.usePortal 走的是手动 look+forward，不经过这里
    this.exclusionAreasStep.push((b) => {
      const ps = NavMovements.avoidPlates || []; if (!b || !b.position) return 0;
      for (const q of ps) if (Math.abs(b.position.x - q.x) < 1 && Math.abs(b.position.z - q.z) < 1 && Math.abs(b.position.y - q.y) < 2) return 1000;
      return 0;
    });
  }

  getBlock(pos, dx, dy, dz) {
    const p = pos ? new Vec3(pos.x + dx, pos.y + dy, pos.z + dz) : null;
    const b = p ? this.bot.blockAt(p, false) : null;
    if (!b) {
      // VOID / unloaded: impassable wall. Stock returns physical:false (walkable) — that's the bug.
      return {
        replaceable: false,
        canFall: false,
        safe: false,
        physical: true,   // <-- impassable
        liquid: false,
        climbable: false,
        height: dy,
        openable: false
      };
    }
    b.climbable = this.climbables.has(b.type);
    b.safe = (b.boundingBox === 'empty' || b.climbable || this.carpets.has(b.type)) && !this.blocksToAvoid.has(b.type);
    b.physical = b.boundingBox === 'block' && !this.fences.has(b.type);
    b.replaceable = this.replaceables.has(b.type) && !b.physical;
    b.liquid = this.liquids.has(b.type);
    b.height = pos.y + dy;
    b.canFall = this.gravityBlocks.has(b.type);
    b.openable = this.openable.has(b.type);
    for (const shape of b.shapes) {
      b.height = Math.max(b.height, pos.y + dy + shape[4]);
    }
    return b;
  }
}

module.exports = NavMovements;
