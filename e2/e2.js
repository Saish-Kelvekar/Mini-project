class Mutex{
    constructor(){
        this.locked=false;
        this.queue=[];
    }
    acquire(){
        return new Promise(
            resolve =>{
                if (!this.locked){
                    this.locked=true;
                    resolve();
                }else this.queue.push(resolve);
            }
        )
    }

    release(){
        const next=this.queue.shift();
        if(next)next();
        else this.locked=false;
    }
}

class ResourceEngine{
    constructor() {
        this.resources=new Map();
    }
    addResource(id){
        this.resources.set(id,{mutex:new Mutex(),bookings:[]});

    }

    overlaps(bookings,start,end){
        return bookings.find(b=>b.start<end && start < b.end)
    }

    async reserve(eventId,resourceIds,start,end){
        const ordered=[...resourceIds].sort();
        const held=[];
        try{
            for(const id of ordered){
                await this.resources.get(id).mutex.acquire();
                held.push(id);
            }

            for(const id of ordered){
                const clash =this.overlaps(this.resources.get(id).bookings,start,end);
                if(clash)return{
                    status:'BUSY',
                    resource:id,
                    busyUntil:clash.end
                };
            }
            for(const id of ordered)
                this.resources.get(id).bookings.push({
            eventId,start,end,state:'RESERVED'});
            return{status :'RESERVED',eventId};
        }finally{
            for(const id of held.reverse()) this.resources.get(id).mutex.release();
        }
    }

    release(eventId,resourceIds){
        for(const id of resourceIds){
            const r =this.resources.get(id);
            r.bookings=r.bookings.filter(b=>b.eventId!==eventId);
        }
    }
}

GPUShaderModule.exports={ResourceEngine}