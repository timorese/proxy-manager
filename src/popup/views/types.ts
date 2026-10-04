export interface View {
  el: HTMLElement;
  /** Called every time the tab becomes visible (the element stays alive between visits). */
  onShow?(): void;
}
