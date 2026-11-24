/**
 * The project's one path, sources to running product, drawn the same on
 * Overview, Product and Releases (studio-backend `project_path.rs`). Its own
 * entry, `@constructor-studio/mfe-shared/path`, as `grid` is: the strip
 * brings a stylesheet and a dictionary that the package's main entry, which
 * the shell imports too, need not carry.
 */

export { ProjectPath, type ProjectPathProps } from './path/ProjectPath';
export {
  PRODUCT_STAGES,
  RELEASE_STAGES,
  STAGE_IDS,
  STAGE_TAB_ROUTE,
  isStageId,
  joinStages,
  stageNumber,
  stageOf,
  stagesFromDelivery,
  stagesFromStatus,
  stagesOf,
  withFocus,
  type DeliveryPathStep,
  type PathStage,
  type StageAction,
  type StageId,
  type StageState,
  type StatusPathStep,
} from './path/stages';
