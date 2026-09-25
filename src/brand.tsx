import React from 'react';
import light from './assets/brand/logo-light.png';
import dark from './assets/brand/logo-dark.png';
export function Brand({inverted=false}:{inverted?:boolean}){return <div className="brand"><img src={inverted?dark:light} alt="ACO!"/></div>}
