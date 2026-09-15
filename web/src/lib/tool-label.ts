const toolLabels: Record<string, string> = {
  revit_execute_csharp: "Execute Revit C#",
  revit_capture_view: "Capture a view",
  revit_ui_observe: "Observe desktop",
  revit_ui_action: "Control desktop",
  read: "Read skill",
  skills_search: "Find skills",
  skill_edit_read: "Read skill for editing",
  skill_save: "Save skill",
  history_list: "Browse execution history",
  history_read: "Read execution history",
};

export function toolLabel(name: string) {
  return toolLabels[name] ?? name.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
}
