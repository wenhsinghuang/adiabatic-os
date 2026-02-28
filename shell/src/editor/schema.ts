// BlockNote editor schema — extends default with AppBlock for live components.

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { AppBlock } from "./blocks/app-block";

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    appComponent: AppBlock,
  },
});

export type AdiabaticSchema = typeof schema;
