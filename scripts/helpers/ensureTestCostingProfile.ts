import { defaultInventoryValuationRepository } from '../../src/server/inventory/inventoryValuationRepository.js';

export interface EnsureTestCostingProfileResult {
  profileId: string;
  assignedItemIds: string[];
}

/**
 * Deterministic test-only helper ensuring participating company/items in test
 * fixtures have an active costing profile and valid item costing assignment.
 * Uses FIFO costing method and preserves any existing valid assignments.
 */
export async function ensureTestCostingProfile(
  companyId: string,
  itemIds: string[],
  userId?: string
): Promise<EnsureTestCostingProfileResult> {
  const profiles = await defaultInventoryValuationRepository.listProfiles(companyId);

  let fifoProfile = profiles.find((p) => p.costingMethod === 'FIFO' && p.isActive);
  if (!fifoProfile) {
    fifoProfile = await defaultInventoryValuationRepository.createProfile(companyId, {
      name: 'Default Test FIFO Profile',
      costingMethod: 'FIFO',
      isDefault: true,
    });
  }

  const assignedItemIds: string[] = [];

  for (const itemId of itemIds) {
    const existing = await defaultInventoryValuationRepository.getItemAssignment(companyId, itemId);
    if (!existing) {
      await defaultInventoryValuationRepository.assignItemProfile(
        companyId,
        itemId,
        fifoProfile.id,
        userId
      );
      assignedItemIds.push(itemId);
    } else {
      assignedItemIds.push(itemId);
    }
  }

  return {
    profileId: fifoProfile.id,
    assignedItemIds,
  };
}
