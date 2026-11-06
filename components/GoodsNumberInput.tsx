"use client";
import type {InputHTMLAttributes} from 'react';
/** Text input avoids native spinner, wheel and arrow-key quantity changes. */
export function GoodsNumberInput({onChange,inputMode='numeric',...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'type'>){
 return <input {...props} type="text" inputMode={inputMode} onChange={event=>{const pattern=inputMode==='decimal'?/^\d*(?:\.\d*)?$/:/^\d*$/;if(pattern.test(event.target.value))onChange?.(event);}}/>;
}
