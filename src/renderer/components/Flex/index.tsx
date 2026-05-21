import React, { forwardRef, PropsWithChildren } from 'react';
import Style from './index.module.css';

interface FlexProps extends React.HTMLAttributes<HTMLElement> {
  vertical?: boolean;
  gap?: React.CSSProperties['gap'];
  style?: React.CSSProperties;
  className?: string;
  justify?: React.CSSProperties['justifyContent'];
  align?: React.CSSProperties['alignItems'];
  wrap?: boolean;
}
const Flex = forwardRef<HTMLDivElement, PropsWithChildren<FlexProps>>((props, ref) => {
  const { className, style = {}, vertical, gap, align, justify, children, wrap, ...other } = props;
  return (
    <div
      {...other}
      ref={ref}
      className={[Style.flex, className].join(' ')}
      style={{
        flexDirection: vertical ? 'column' : 'row',
        gap,
        justifyContent: justify,
        alignItems: align,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style
      }}
    >
      {children}
    </div>
  );
});

export { Flex };
