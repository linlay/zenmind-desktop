import { Button, Tooltip, type ButtonProps } from "antd";
import { ActionIcon, type ActionIconName } from "../../components/ActionIcon";

// Settings resource actions share the control center's compact button surface.
export function SettingsActionButton({ label, icon, tone = "default", ...props }: Omit<ButtonProps, "children" | "icon" | "type" | "className"> & {
  label: string;
  icon: ActionIconName;
  tone?: "default" | "primary" | "danger";
}) {
  return <Tooltip title={label} arrow={false} trigger={["hover", "focus"]} classNames={{ root: "settings-action-tooltip" }}>
    <Button {...props} type="text" aria-label={label} icon={<ActionIcon name={icon} />}
      className={`service-action-button web-icon-action${tone === "default" ? "" : ` is-${tone}`}`} />
  </Tooltip>;
}
