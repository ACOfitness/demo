import React,{useLayoutEffect,useRef,useState,useId} from 'react';
import {createPortal} from 'react-dom';

// Keep actions outside the scrolling body while preserving native form submission.
export function DialogActions({children}:{children:React.ReactNode}){
 const marker=useRef<HTMLSpanElement>(null),id=useId();
 const [host,setHost]=useState<HTMLElement|null>(null),[formId,setFormId]=useState<string>();
 useLayoutEffect(()=>{
  const form=marker.current?.closest('form');
  if(form){if(!form.id)form.id='dialog-form-'+id;setFormId(form.id)}
  setHost(marker.current?.closest('dialog')?.querySelector<HTMLElement>('.dialog-actions-host')||null);
 },[id]);
 const actions=<div className="form-actions fixed-dialog-actions">{React.Children.map(children,child=>{
  if(!React.isValidElement<React.ButtonHTMLAttributes<HTMLButtonElement>>(child)||child.type!=='button')return child;
  return React.cloneElement(child,{form:formId,type:child.props.type||(formId?'submit':'button')});
 })}</div>;
 return <><span ref={marker} hidden/>{host?createPortal(actions,host):actions}</>;
}
